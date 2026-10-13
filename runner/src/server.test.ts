import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "./server.ts";

const post = (body: unknown) =>
  handle(
    new Request("http://runner/jobs", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("runner server", () => {
  test("health and ping", async () => {
    expect(await (await handle(new Request("http://runner/health"))).json()).toMatchObject({
      ok: true,
    });
    const res = await post({ type: "ping" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { git: string }).git).toContain("git version");
  });

  test("unknown jobs and bad bodies are 400", async () => {
    expect((await post({ type: "nope" })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
  });
});

describe("setupRepo", () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  test("adds remotes with per-remote auth headers and fetches", async () => {
    const work = await mkdtemp(join(tmpdir(), "work-"));
    const origin = await mkdtemp(join(tmpdir(), "origin-"));
    dirs.push(work, origin);
    process.env.MYCELIUM_WORK_DIR = work;
    const { sh, setupRepo } = await import(`./git.ts?work=${Date.now()}`);
    const ident = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    await sh(origin, ["git", "init", "-q", "-b", "main"]);
    await sh(origin, ["git", "commit", "-q", "--allow-empty", "-m", "first"], ident);

    const git = await setupRepo("demo", [{ name: "origin", url: origin, token: "t1" }]);
    expect(git.dir).toBe(join(work, "demo"));
    expect((await git("rev-parse", "origin/main")).code).toBe(0);
    // Reused while warm, with the new token.
    const again = await setupRepo("demo", [{ name: "origin", url: origin, token: "t2" }]);
    expect((await again("config", "--get-all", `http.${origin}.extraHeader`)).out).toBe(
      "Authorization: Bearer t2",
    );
    await expect(setupRepo("../evil", [])).rejects.toThrow();
  });
});
