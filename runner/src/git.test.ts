import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authEnv, setupRepo, sh, WORK_DIR } from "./git.ts";

// Credentials never live in the shared clone: concurrent jobs on one repo
// (a workflow with a read token, a merge with a write token) each keep theirs.

const ident = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
let origin: string;
const repo = `creds-${Date.now()}`;

beforeAll(async () => {
  origin = await mkdtemp(join(tmpdir(), "origin-"));
  await sh(origin, ["git", "init", "-q", "-b", "main"]);
  await writeFile(join(origin, "a.txt"), "a\n");
  await sh(origin, ["git", "add", "."]);
  await sh(origin, ["git", "commit", "-q", "-m", "a"], ident);
});
afterAll(async () => {
  await rm(origin, { recursive: true, force: true });
  await rm(join(WORK_DIR, repo), { recursive: true, force: true });
});

test("authEnv carries each remote's header in git's environment config", () => {
  expect(authEnv([{ name: "r", url: "https://x/r.git", token: "tok" }])).toEqual({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://x/r.git.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: Bearer tok",
  });
});

test("concurrent jobs on one clone keep their own tokens", async () => {
  const key = `http.${origin}.extraheader`;
  const [read, write] = await Promise.all([
    setupRepo(repo, [{ name: "origin", url: origin, token: "read-token" }]),
    setupRepo(repo, [{ name: "origin", url: origin, token: "write-token" }]),
  ]);
  expect(read.dir).toBe(write.dir);
  expect((await read("config", "--get-all", key)).out).toBe("Authorization: Bearer read-token");
  expect((await write("config", "--get-all", key)).out).toBe("Authorization: Bearer write-token");
  // Nothing stored in the clone itself.
  const stored = await sh(read.dir, ["git", "config", "--local", "--get-all", key]);
  expect(stored.out).toBe("");
});
