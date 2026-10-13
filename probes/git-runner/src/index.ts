import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

// One container per target lineage: blends into the same lineage share an instance.
export class GitRunner extends Container {
	defaultPort = 8080;
	sleepAfter = "5m";
}

type Op =
	| { op: "cherry-pick"; from: string; commit: string }
	| { op: "merge"; from: string; ref?: string }
	| { op: "rebase"; onto: string; ref?: string };
type BlendRequest = { agent: string; target: string; ops: Op[]; test?: string; push?: boolean };

const runners = env.GIT_RUNNER as unknown as DurableObjectNamespace<GitRunner>;
const json = (data: unknown, status = 200) => Response.json(data, { status });

export default {
	async fetch(req: Request) {
		const url = new URL(req.url);
		if (url.pathname === "/health") {
			const t0 = Date.now();
			const res = await getContainer(runners, "health").fetch("http://runner/health");
			return json({ container: await res.json(), ms: Date.now() - t0 });
		}
		if (req.method === "POST" && url.pathname === "/blend") {
			if (req.headers.get("Authorization") !== `Bearer ${env.ADMIN_KEY}`) return json({ error: "unauthorized" }, 401);
			const job = (await req.json()) as BlendRequest;

			// Mint short-lived repo-scoped tokens: write on the target, read on every source.
			const sources = new Set(job.ops.map((o) => ("from" in o ? o.from : o.onto)).filter((n) => n !== job.target));
			const remotes = await Promise.all(
				[job.target, ...sources].map(async (name) => {
					using repo = await env.ARTIFACTS.get(name);
					const [info, tok] = await Promise.all([repo.info(), repo.createToken(name === job.target ? "write" : "read", 600)]);
					return { name, url: info.remote, token: tok.plaintext, scope: name === job.target ? "write" : "read" };
				}),
			);

			const t0 = Date.now();
			const res = await getContainer(runners, job.target).fetch("http://runner/run", {
				method: "POST",
				body: JSON.stringify({ ...job, remotes }),
			});
			const result = (await res.json()) as Record<string, unknown>;
			return json({
				request: job,
				tokens: remotes.map(({ name, scope }) => ({ repo: name, scope, ttl: 600 })),
				...result,
				worker_ms: Date.now() - t0,
			});
		}
		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
