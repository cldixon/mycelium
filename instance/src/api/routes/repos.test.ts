import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWebSession, setSetting } from "@mycelium/platform";
import { createTestD1 } from "@mycelium/platform/testing";
import { app } from "../app.js";
import { getDb } from "../../db/migrations.js";
import { importUrlError } from "./repos.js";
import { branchNameError, lastActivity, repoNameError } from "../../shared/types.js";
import { pickDefaultBranch } from "../../git/artifacts.js";
import type { Bindings } from "../bindings.js";

const OWNER = "did:plc:ownerabcdefghijklmnopqrs";
const BASE = "http://mycelium.test";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("repoNameError", () => {
  test("accepts ordinary names", () => {
    for (const name of ["a", "mycelium", "my-repo", "my_repo", "v1.2", "A9", "x".repeat(100)]) {
      expect(repoNameError(name)).toBeNull();
    }
  });
  test("rejects bad shapes", () => {
    for (const name of [
      "",
      "-x",
      ".x",
      "_x",
      "a b",
      "a/b",
      "é",
      "x".repeat(101),
      "a--b",
      "x.git",
    ]) {
      expect(repoNameError(name)).not.toBeNull();
    }
  });
  test("rejects reserved route names, any case", () => {
    for (const name of ["signin", "settings", "api", "oauth", "health", "new", "Settings"]) {
      expect(repoNameError(name)).toContain("reserved");
    }
  });
});

describe("branchNameError", () => {
  test("accepts branch names with slashes", () => {
    for (const b of ["main", "master", "feature/x", "v1.0", "a_b-c"]) {
      expect(branchNameError(b)).toBeNull();
    }
  });
  test("rejects invalid refs", () => {
    for (const b of [
      "",
      "a b",
      "a..b",
      "/a",
      "a/",
      "-a",
      "a.lock",
      "a~1",
      "a^",
      "a:b",
      "@",
      "a@{1",
    ]) {
      expect(branchNameError(b)).not.toBeNull();
    }
  });
});

test("importUrlError", () => {
  expect(importUrlError("https://github.com/octocat/Hello-World.git")).toBeNull();
  expect(importUrlError("http://github.com/x/y")).toContain("https");
  expect(importUrlError("git@github.com:x/y.git")).not.toBeNull();
  expect(importUrlError("https://u:p@github.com/x/y")).toContain("credentials");
});

test("pickDefaultBranch trusts HEAD, then the requested branch", () => {
  const refs = {
    head: "master",
    branches: [
      { name: "master", sha: "a" },
      { name: "dev", sha: "b" },
    ],
    tags: [],
  };
  expect(pickDefaultBranch(refs, null, "main")).toBe("master");
  expect(pickDefaultBranch({ ...refs, head: undefined }, "dev", "main")).toBe("dev");
  expect(pickDefaultBranch({ ...refs, head: undefined }, null, "main")).toBe("master");
  expect(pickDefaultBranch({ branches: [], tags: [] }, null, "main")).toBe("main");
});

test("lastActivity is the later of update and push", () => {
  expect(lastActivity({ updatedAt: "2026-01-01", pushedAt: null })).toBe("2026-01-01");
  expect(lastActivity({ updatedAt: "2026-01-01", pushedAt: "2026-02-01" })).toBe("2026-02-01");
  expect(lastActivity({ updatedAt: "2026-03-01", pushedAt: "2026-02-01" })).toBe("2026-03-01");
});

describe("repos API", () => {
  let env: Bindings;
  let db: D1Database;
  let cookie: string;
  let dispose: () => Promise<void>;
  const store = new Map<string, { description?: string }>();

  const fakeArtifacts = {
    async create(name: string, opts?: { description?: string }) {
      if (store.has(name)) {
        throw Object.assign(new Error("exists"), {
          name: "ArtifactsError",
          code: "ALREADY_EXISTS",
        });
      }
      store.set(name, { description: opts?.description });
      return {
        id: name,
        name,
        description: opts?.description ?? null,
        defaultBranch: "main",
        remote: `https://${ACCOUNT}.artifacts.cloudflare.net/git/myc-test/${name}.git`,
        token: "art_v1_x",
      };
    },
    async delete(name: string) {
      return store.delete(name);
    },
    async get(name: string) {
      return {
        createToken: async (scope: string) => ({
          id: "t",
          plaintext: `tok-${name}-${scope}`,
          scope,
          expiresAt: "2030-01-01T00:00:00Z",
        }),
        [Symbol.dispose]() {},
      };
    },
  };

  beforeEach(async () => {
    store.clear();
    const t = await createTestD1();
    dispose = t.dispose;
    db = await getDb(t.db);
    env = {
      DB: t.db,
      INSTANCE_TITLE: "mycelium",
      ARTIFACTS: fakeArtifacts,
      ASSETS: { fetch: async () => new Response("spa") },
    } as unknown as Bindings;
    await setSetting(db, "owner_did", OWNER);
    cookie = `mycelium_session=${await createWebSession(db, OWNER)}`;
  });
  afterEach(() => dispose());

  const call = (method: string, path: string, body?: unknown, auth = true) =>
    app.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          ...(auth && { cookie }),
          origin: BASE,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );

  test("create, read, patch, credentials, delete", async () => {
    let res = await call("POST", "/api/repos", { name: "tiny", description: " hi " });
    expect(res.status).toBe(201);
    const repo = (await res.json()) as any;
    expect(repo).toMatchObject({
      name: "tiny",
      description: "hi",
      visibility: "private",
      defaultBranch: "main",
      pushEvents: false,
      pushedAt: null,
    });

    expect((await call("POST", "/api/repos", { name: "tiny" })).status).toBe(409);
    expect((await call("GET", "/api/repos/tiny", undefined, false)).status).toBe(404);

    res = await call("PATCH", "/api/repos/tiny", {
      visibility: "public",
      defaultBranch: "trunk",
      description: "",
    });
    expect(await res.json()).toMatchObject({
      visibility: "public",
      defaultBranch: "trunk",
      description: null,
    });
    expect((await call("GET", "/api/repos/tiny", undefined, false)).status).toBe(200);
    expect((await call("PATCH", "/api/repos/tiny", { visibility: "x" })).status).toBe(400);

    res = await call("POST", "/api/repos/tiny/git-credentials", { scope: "write" });
    expect(await res.json()).toMatchObject({ token: "tok-tiny-write", remote: repo.remote });
    expect((await call("POST", "/api/repos/tiny/git-credentials", { scope: "admin" })).status).toBe(
      400,
    );
    expect(
      (await call("POST", "/api/repos/tiny/git-credentials", { scope: "read" }, false)).status,
    ).toBe(401);

    await db
      .prepare(
        "INSERT INTO pushes (repo, ref, commits, at) VALUES ('tiny', 'refs/heads/main', '[]', ?)",
      )
      .bind("2999-01-01T00:00:00Z")
      .run();
    res = await call("GET", "/api/repos");
    expect(((await res.json()) as any).repos[0].pushedAt).toBe("2999-01-01T00:00:00Z");

    expect((await call("DELETE", "/api/repos/tiny")).status).toBe(200);
    expect(store.has("tiny")).toBe(false);
    expect((await call("GET", "/api/repos/tiny")).status).toBe(404);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM pushes").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  test("validation and owner-only", async () => {
    expect((await call("POST", "/api/repos", { name: "settings" })).status).toBe(400);
    expect((await call("POST", "/api/repos", { name: "a--b" })).status).toBe(400);
    expect((await call("POST", "/api/repos", { name: "ok", branch: "dev" })).status).toBe(400);
    expect(
      (await call("POST", "/api/repos", { name: "ok", importUrl: "http://x.test/y" })).status,
    ).toBe(400);
    expect((await call("POST", "/api/repos", { name: "ok" }, false)).status).toBe(401);
    expect(store.size).toBe(0);
  });
});
