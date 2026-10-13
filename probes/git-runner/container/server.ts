// Git job runner. Receives a blend job from the Worker, runs real git, returns a transcript.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Remote = { name: string; url: string; token: string };
type Op =
	| { op: "cherry-pick"; from: string; commit: string }
	| { op: "merge"; from: string; ref?: string }
	| { op: "rebase"; onto: string; ref?: string };
type Job = { agent: string; target: string; remotes: Remote[]; ops: Op[]; test?: string; push?: boolean };

const clip = (s: string, n = 2500) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);

async function sh(cwd: string, cmd: string[], env: Record<string, string> = {}) {
	const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out: out.trim(), err: err.split("\n").filter((l) => !l.startsWith("warning: ")).join("\n").trim() };
}

async function run(job: Job) {
	const dir = await mkdtemp(join(tmpdir(), "blend-"));
	const t0 = Date.now();
	const ident = { GIT_AUTHOR_NAME: job.agent, GIT_AUTHOR_EMAIL: `${job.agent}@agents.mycelium`, GIT_COMMITTER_NAME: job.agent, GIT_COMMITTER_EMAIL: `${job.agent}@agents.mycelium` };
	const git = (...args: string[]) => sh(dir, ["git", ...args], ident);
	const head = async () => (await git("rev-parse", "--short", "HEAD")).out;
	const steps: any[] = [];
	let rewritten = false;

	try {
		await git("init", "-q", "-b", "main");
		for (const r of job.remotes) {
			// Each remote gets its own token, matched by URL prefix.
			await git("config", "--add", `http.${r.url}.extraHeader`, `Authorization: Bearer ${r.token}`);
			await git("remote", "add", r.name, r.url);
		}
		const f = await git("fetch", "-q", "--all");
		await git("checkout", "-q", "-B", "main", `${job.target}/main`);
		steps.push({ step: "setup", ok: f.code === 0, head: await head(), remotes: job.remotes.map((r) => r.name), ms: Date.now() - t0 });

		for (const op of job.ops) {
			const before = await head();
			const s0 = Date.now();
			let r;
			if (op.op === "cherry-pick") {
				r = await git("cherry-pick", op.commit);
				if (r.code === 0) {
					await git("commit", "-q", "--amend", "--no-edit", "--trailer", `Agent: ${job.agent}`, "--trailer", `Adopted-From: ${op.from}@${op.commit}`, "--trailer", "Method: cherry-pick", "--trailer", "Origin: adopted");
				}
			} else if (op.op === "merge") {
				const ref = `${op.from}/${op.ref ?? "main"}`;
				r = await git("merge", "--no-ff", ref, "-m", `Merge ${ref} into ${job.target}\n\nAgent: ${job.agent}\nAdopted-From: ${op.from}@${(await git("rev-parse", ref)).out}\nMethod: merge`);
			} else {
				const onto = `${op.onto}/${op.ref ?? "main"}`;
				// `git cherry` marks commits already upstream (same patch-id) with "-": rebase will drop those.
				const cherry = (await git("cherry", onto, "HEAD")).out.split("\n").filter(Boolean);
				r = await git("rebase", onto);
				rewritten = true;
				steps.push({
					step: `rebase onto ${onto}`,
					ok: r.code === 0,
					before, after: await head(),
					kept: cherry.filter((l) => l.startsWith("+")).map((l) => l.slice(2, 9)),
					dropped_already_upstream: cherry.filter((l) => l.startsWith("-")).map((l) => l.slice(2, 9)),
					output: clip([r.out, r.err].filter(Boolean).join("\n")),
					ms: Date.now() - s0,
				});
				if (r.code !== 0) return await conflict(git, "rebase", steps, dir, t0);
				continue;
			}
			steps.push({ step: `${op.op} ${"commit" in op ? op.commit.slice(0, 7) : ""} from ${op.from}`.replace("  ", " "), ok: r.code === 0, before, after: await head(), output: clip([r.out, r.err].filter(Boolean).join("\n")), ms: Date.now() - s0 });
			if (r.code !== 0) return await conflict(git, op.op, steps, dir, t0);
		}

		if (job.test) {
			const s0 = Date.now();
			const t = await sh(dir, ["sh", "-c", job.test]);
			steps.push({ step: `test: ${job.test}`, ok: t.code === 0, exit: t.code, output: clip((t.out + "\n" + t.err).trim().split("\n").slice(-8).join("\n")), ms: Date.now() - s0 });
			if (t.code !== 0) return { status: "tests_failed", steps, ...(await summary(git, t0)) };
		}

		if (job.push) {
			const s0 = Date.now();
			const p = await git("push", ...(rewritten ? ["--force-with-lease"] : []), job.target, "HEAD:main");
			steps.push({ step: `push ${job.target} main${rewritten ? " (force-with-lease: history rewritten)" : ""}`, ok: p.code === 0, output: clip([p.out, p.err].filter(Boolean).join("\n")), ms: Date.now() - s0 });
			if (p.code !== 0) return { status: "push_failed", steps, ...(await summary(git, t0)) };
		}
		return { status: "ok", steps, ...(await summary(git, t0)) };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function conflict(git: (...a: string[]) => Promise<any>, kind: string, steps: any[], _dir: string, t0: number) {
	const files = (await git("diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
	const markers = (await git("diff")).out;
	await git(kind === "rebase" ? "rebase" : kind, "--abort");
	return { status: "conflict", conflicted_files: files, conflict_diff: clip(markers, 3000), steps, ...(await summary(git, t0)) };
}

async function summary(git: (...a: string[]) => Promise<any>, t0: number) {
	return { head: (await git("rev-parse", "HEAD")).out, log: (await git("log", "--oneline", "-8")).out.split("\n"), total_ms: Date.now() - t0 };
}

Bun.serve({
	port: 8080,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/health") return Response.json({ ok: true, git: (await sh("/", ["git", "--version"])).out, bun: Bun.version });
		if (req.method === "POST" && url.pathname === "/run") return Response.json(await run((await req.json()) as Job));
		return new Response("not found", { status: 404 });
	},
});
console.log("git runner on :8080");
