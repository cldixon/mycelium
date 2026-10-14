/**
 * Before the agents start: check the repository is ready (or, with --setup, make it ready),
 * optionally reset it (--reset), and pick each agent's feature and role from what main still
 * lacks.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunTest, Clone, type FleetAgent, parseCredentials, ToolError } from "./agent";
import { dirFiles, FEATURES, type Feature, type Role } from "./features";

const SEED = join(import.meta.dir, "seed");
export const WORKFLOW = "test";
export const BASE_TAG = "fleet-base";

/** The REST API, for the few things MCP has no tool for (required checks, closing a PR). */
export async function rest<T>(
  url: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as T;
  return { status: res.status, data };
}

type RepoInfo = {
  name: string;
  defaultBranch: string;
  branches: { name: string; sha: string }[];
  tags: { name: string; sha: string }[];
  empty?: boolean;
  visibility: string;
};

export async function getRepo(a: FleetAgent, repo: string): Promise<RepoInfo | null> {
  try {
    return await a.json<RepoInfo>("get_repo", { repo });
  } catch (error) {
    if (error instanceof ToolError && error.status === 404) return null;
    throw error;
  }
}

function clone(a: FleetAgent, repo: string, dir: string) {
  return new Clone(dir, async () => parseCredentials(await a.call("git_credentials", { repo })), {
    name: a.name,
    email: `${a.name}@agents.mycelium.invalid`,
  });
}

/** What preflight found; `problems` are printed with how to fix them. */
export type Readiness = { problems: string[]; notes: string[]; defaultBranch: string };

export async function preflight(
  a: FleetAgent,
  url: string,
  repo: string,
  ownerToken: string,
): Promise<Readiness> {
  const problems: string[] = [];
  const notes: string[] = [];
  const info = await getRepo(a, repo);
  if (!info) {
    return {
      problems: [`No repository "${repo}" (run with --setup to create it from demo/fleet/seed).`],
      notes,
      defaultBranch: "main",
    };
  }
  const main = info.defaultBranch;
  if (info.empty || info.branches.length === 0) {
    problems.push(`"${repo}" is empty (run with --setup to push demo/fleet/seed).`);
    return { problems, notes, defaultBranch: main };
  }
  const workflows = await a.json<{ workflows: { name: string; on: string[] }[] }>(
    "list_workflows",
    { repo },
  );
  const test = workflows.workflows.find((w) => w.name === WORKFLOW);
  if (!test) {
    problems.push(
      `No "${WORKFLOW}" workflow on ${main} (add .mycelium/workflows/test.yml, or run with --setup).`,
    );
  } else if (!test.on.includes("pull_request")) {
    problems.push(`The "${WORKFLOW}" workflow doesn't run on pull_request.`);
  }
  const required = await rest<{ workflows: string[] }>(
    url,
    ownerToken,
    "GET",
    `/api/repos/${encodeURIComponent(repo)}/checks/required?branch=${encodeURIComponent(main)}`,
  );
  if (!required.data?.workflows?.includes(WORKFLOW)) {
    problems.push(
      `"${WORKFLOW}" is not a required check on ${main} (Settings of the repo → Required checks, or run with --setup).`,
    );
  }
  const settings = await rest<{ pushEvents?: boolean }>(url, ownerToken, "GET", "/api/settings");
  if (settings.status === 200 && settings.data?.pushEvents === false) {
    notes.push(
      "Push events are off (no CF_API_TOKEN secret): agents start missing checks with run_workflow.",
    );
  }
  if (!info.tags.some((t) => t.name === BASE_TAG)) {
    notes.push(`No ${BASE_TAG} tag yet: --reset needs one (--setup tags the current ${main}).`);
  }
  return { problems, notes, defaultBranch: main };
}

/** --setup: create the repo from the seed if needed, add the workflow, require it, tag the base. */
export async function setup(
  a: FleetAgent,
  url: string,
  repo: string,
  ownerToken: string,
  work: string,
): Promise<void> {
  let info = await getRepo(a, repo);
  if (!info) {
    await a.call("create_repo", {
      name: repo,
      visibility: "public",
      description: "A small HTTP router for fetch-style handlers",
    });
    a.say(`created repository ${repo} (public)`);
    info = await getRepo(a, repo);
  }
  const main = info?.defaultBranch ?? "main";
  const dir = join(work, "setup");
  const git = clone(a, repo, dir);
  if (!info || info.empty || info.branches.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    cpSync(SEED, dir, { recursive: true });
    await git.ok(["init", "-q", "-b", main]);
    const creds = parseCredentials(await a.call("git_credentials", { repo }));
    await git.ok(["remote", "add", "origin", creds.remote]);
    await git.ok(["add", "-A"]);
    await git.ok(["commit", "-qm", "tinyroute: a small router for fetch handlers"]);
    await git.netOk(["push", "-q", "origin", `HEAD:refs/heads/${main}`]);
    a.say(`pushed the seed to ${main}`);
  } else {
    await git.clone();
    const f = dirFiles(dir);
    if (!f.exists(".mycelium/workflows/test.yml")) {
      f.write(".mycelium/workflows/test.yml", dirFiles(SEED).read(".mycelium/workflows/test.yml"));
      await git.ok(["add", "-A"]);
      await git.ok(["commit", "-qm", "Add the test workflow"]);
      await git.netOk(["push", "-q", "origin", `HEAD:refs/heads/${main}`]);
      a.say(`added .mycelium/workflows/test.yml to ${main}`);
    }
  }
  const path = `/api/repos/${encodeURIComponent(repo)}/checks/required`;
  const current = await rest<{ workflows: string[] }>(
    url,
    ownerToken,
    "GET",
    `${path}?branch=${main}`,
  );
  const workflows = current.data?.workflows ?? [];
  if (!workflows.includes(WORKFLOW)) {
    const put = await rest(url, ownerToken, "PUT", path, {
      branch: main,
      workflows: [...workflows, WORKFLOW],
    });
    if (put.status === 200) a.say(`required check "${WORKFLOW}" on ${main}`);
    else {
      a.say(
        `could not require "${WORKFLOW}" (HTTP ${put.status}): open the repo's Settings → Required checks and add "${WORKFLOW}" for ${main}`,
      );
    }
  }
  const refs = await getRepo(a, repo);
  if (!refs?.tags.some((t) => t.name === BASE_TAG)) {
    const sha = refs?.branches.find((b) => b.name === main)?.sha;
    if (sha) {
      if (!dirFiles(dir).exists(".git")) await git.clone();
      await git.netOk(["fetch", "-q", "origin", main]);
      await git.netOk(["push", "-q", "origin", `${sha}:refs/tags/${BASE_TAG}`]);
      a.say(`tagged ${main} (${sha.slice(0, 7)}) as ${BASE_TAG}: --reset returns here`);
    }
  }
}

/** --reset: close open pull requests, delete fleet branches, move main back to the base tag. */
export async function reset(
  a: FleetAgent,
  url: string,
  repo: string,
  ownerToken: string,
  work: string,
): Promise<void> {
  const info = await getRepo(a, repo);
  if (!info) throw new Error(`No repository ${repo}`);
  const base = info.tags.find((t) => t.name === BASE_TAG);
  if (!base) throw new Error(`No ${BASE_TAG} tag: run with --setup first (it tags main).`);
  const main = info.defaultBranch;
  const open = await a.json<{ pulls: { number: number }[] }>("list_pulls", { repo, state: "open" });
  for (const p of open.pulls) {
    // No MCP tool closes a pull request; the REST API does.
    await rest(
      url,
      ownerToken,
      "PATCH",
      `/api/repos/${encodeURIComponent(repo)}/pulls/${p.number}`,
      {
        state: "closed",
      },
    );
  }
  if (open.pulls.length) a.say(`closed ${open.pulls.length} open pull request(s)`);
  const dir = join(work, "reset");
  const git = clone(a, repo, dir);
  await git.clone();
  const ids = new Set(FEATURES.map((f) => f.id));
  const stale = info.branches.filter((b) => b.name !== main && ids.has(b.name.split("/").pop()!));
  const refspecs = [
    `+${base.sha}:refs/heads/${main}`,
    ...stale.map((b) => `:refs/heads/${b.name}`),
  ];
  const r = await git.net(["push", "-q", "origin", ...refspecs]);
  if (r.code !== 0) throw new Error(`reset push failed: ${r.err}`);
  a.say(
    `reset ${main} to ${BASE_TAG} (${base.sha.slice(0, 7)}) and deleted ${stale.length} fleet branch(es)`,
  );
}

export type Assignment = { feature: Feature; role: Role };

/**
 * Pick features for `slots` (roles in agent order) from the ones main still lacks and that apply
 * and pass on it; clean ones never share a region with anything else in the run, the pair shares
 * one with each other (so the second to merge conflicts).
 */
export async function plan(
  a: FleetAgent,
  repo: string,
  slots: Role[],
  work: string,
): Promise<Assignment[]> {
  const dir = join(work, "plan");
  const git = clone(a, repo, dir);
  await git.clone();
  const base = dirFiles(dir);
  const fits = async (features: Feature[]) => {
    const tmp = mkdtempSync(join(tmpdir(), "fleet-plan-"));
    try {
      for (const entry of readdirSync(dir)) {
        if (entry !== ".git") cpSync(join(dir, entry), join(tmp, entry), { recursive: true });
      }
      for (const f of features) f.apply(dirFiles(tmp));
      return (await bunTest(tmp)).ok;
    } catch {
      return false;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
  const available: Feature[] = [];
  for (const f of FEATURES) if (!base.exists(f.test) && (await fits([f]))) available.push(f);

  const chosen: Feature[] = [];
  const taken = new Set<string>();
  const disjoint = (f: Feature) => f.regions.every((r) => !taken.has(r));
  const take = (f: Feature) => {
    chosen.push(f);
    for (const r of f.regions) taken.add(r);
  };
  const out: (Assignment | null)[] = slots.map(() => null);

  // The pair first (it constrains the most), then the breaker, then clean features.
  const pairSlots = slots.flatMap((r, i) => (r === "pair" ? [i] : []));
  if (pairSlots.length >= 2) {
    const candidates = available.filter((f) => f.roles.includes("pair"));
    let found = false;
    for (const x of candidates) {
      for (const y of candidates) {
        if (x === y || !x.regions.some((r) => y.regions.includes(r))) continue;
        if (!(await fits([x, y])) || !(await fits([y, x]))) continue;
        out[pairSlots[0]!] = { feature: x, role: "pair" };
        out[pairSlots[1]!] = { feature: y, role: "pair" };
        take(x);
        take(y);
        found = true;
        break;
      }
      if (found) break;
    }
  }
  for (const [i, role] of slots.entries()) {
    if (out[i] || role === "pair") continue;
    const pick = available.find(
      (f) => !chosen.includes(f) && f.roles.includes(role) && disjoint(f),
    );
    if (pick) {
      out[i] = { feature: pick, role };
      take(pick);
    }
  }
  // A role that found nothing falls back to a clean feature.
  for (const [i] of slots.entries()) {
    if (out[i]) continue;
    const pick = available.find(
      (f) => !chosen.includes(f) && f.roles.includes("clean") && disjoint(f),
    );
    if (!pick) {
      throw new Error(
        `Not enough features left on main for ${slots.length} agents (${available.length} available). Run with --reset to start over from the ${BASE_TAG} tag.`,
      );
    }
    out[i] = { feature: pick, role: "clean" };
    take(pick);
  }
  const all = out as Assignment[];
  if (!(await fits(all.map((x) => x.feature)))) {
    a.say("warning: the planned features don't all pass together on main");
  }
  return all;
}
