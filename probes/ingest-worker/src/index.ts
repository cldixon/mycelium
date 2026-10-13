import { env } from "cloudflare:workers";

type CommitIn = {
	id: string;
	message: string;
	timestamp: string;
	author: { name: string; email: string };
	parents: string[];
};
type ArtifactsEvent = {
	type: string;
	source: { type: string; namespace?: string; repoName?: string };
	payload: any;
	metadata: { eventTimestamp: string };
};

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS repos (name TEXT PRIMARY KEY, source TEXT, created_at TEXT)`,
	`CREATE TABLE IF NOT EXISTS events (msg_id TEXT PRIMARY KEY, type TEXT, repo TEXT, at TEXT, body TEXT)`,
	`CREATE TABLE IF NOT EXISTS commits (repo TEXT, sha TEXT, author TEXT, subject TEXT, at TEXT, parents TEXT, PRIMARY KEY (repo, sha))`,
	`CREATE TABLE IF NOT EXISTS trailers (repo TEXT, sha TEXT, key TEXT, value TEXT)`,
	`CREATE INDEX IF NOT EXISTS trailers_kv ON trailers (key, value)`,
];
let ready: Promise<unknown> | undefined;
const migrate = () => (ready ??= env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))));

// Git trailers: the last paragraph of a message, every line "Key: value".
export function parseTrailers(message: string): [string, string][] {
	const paras = message.trim().split(/\n\s*\n/);
	if (paras.length < 2) return [];
	const lines = paras[paras.length - 1].split("\n").filter((l) => !/^\(cherry picked from commit/.test(l));
	const out: [string, string][] = [];
	for (const line of lines) {
		const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(line.trim());
		if (!m) return [];
		out.push([m[1], m[2]]);
	}
	return out;
}

async function ingest(msgId: string, ev: ArtifactsEvent) {
	const repo = ev.source.repoName ?? null;
	const stmts = [
		env.DB.prepare(`INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?)`).bind(
			msgId, ev.type, repo, ev.metadata.eventTimestamp, JSON.stringify(ev),
		),
	];
	if (ev.type === "cf.artifacts.repo.pushed" && repo) {
		// Events list commits newest first; store them oldest first.
		for (const c of [...(ev.payload.commits as CommitIn[])].reverse()) {
			stmts.push(
				env.DB.prepare(`INSERT OR IGNORE INTO commits VALUES (?, ?, ?, ?, ?, ?)`).bind(
					repo, c.id, c.author.name, c.message.split("\n")[0], c.timestamp, JSON.stringify(c.parents),
				),
				env.DB.prepare(`DELETE FROM trailers WHERE repo = ? AND sha = ?`).bind(repo, c.id),
			);
			for (const [k, v] of parseTrailers(c.message)) {
				stmts.push(env.DB.prepare(`INSERT INTO trailers VALUES (?, ?, ?, ?)`).bind(repo, c.id, k, v));
			}
		}
	}
	if (ev.type.startsWith("cf.artifacts.repo.") && ["created", "forked", "imported"].some((t) => ev.type.endsWith(t)) && repo) {
		stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO repos VALUES (?, ?, ?)`).bind(repo, ev.payload.sourceUrl ?? null, ev.payload.createdAt));
	}
	await env.DB.batch(stmts);
}

async function subscribe(repo: string) {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/event_subscriptions/subscriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			name: `repo-${repo}`.slice(0, 64),
			enabled: true,
			source: { type: "artifacts.repo", namespace: env.NAMESPACE, repo_name: repo },
			destination: { type: "queues.queue", queue_id: env.EVENTS_QUEUE_ID },
			events: ["pushed", "cloned", "fetched", "token.created"],
		}),
	});
	const body: any = await res.json();
	return body.success ? { id: body.result.id } : { error: body.errors };
}

// Resolve ref -> commit -> root tree, then walk one tree per path segment.
async function resolvePath(repo: ArtifactsRepo, ref: string, filePath: string) {
	const [head] = await repo.log({ ref, limit: 1 });
	if (!head) return null;
	let entry: { hash: string; type: string; name: string; mode: string } = { hash: head.treeHash, type: "tree", name: "", mode: "40000" };
	for (const seg of filePath.split("/").filter(Boolean)) {
		if (entry.type !== "tree") return null;
		const next = (await repo.readTree(entry.hash))?.find((e) => e.name === seg);
		if (!next) return null;
		entry = next;
	}
	return entry;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const all = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all()).results;

export default {
	async queue(batch: MessageBatch<unknown>) {
		await migrate();
		for (const msg of batch.messages) {
			const ev = (typeof msg.body === "string" ? JSON.parse(msg.body) : msg.body) as ArtifactsEvent;
			await ingest(msg.id, ev);
			msg.ack();
		}
	},

	async fetch(req: Request) {
		await migrate();
		const url = new URL(req.url);
		const path = url.pathname.split("/").filter(Boolean);

		if (req.method === "GET" && path.length === 0) {
			const [counts] = await all(
				`SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM commits) AS commits, (SELECT count(DISTINCT repo) FROM commits) AS repos_with_pushes`,
			);
			return json({ service: "mycelium-ingest", namespace: env.NAMESPACE, ...counts });
		}
		if (req.method === "GET" && path[0] === "events") {
			const rows = await all(`SELECT msg_id, type, repo, at FROM events ORDER BY at DESC LIMIT ?`, Number(url.searchParams.get("limit") ?? 20));
			return json(rows);
		}
		if (req.method === "GET" && path[0] === "repos" && path[2] === "commits") {
			const commits = await all(`SELECT sha, author, subject, at, parents FROM commits WHERE repo = ? ORDER BY at, rowid`, path[1]);
			const trailers = await all(`SELECT sha, key, value FROM trailers WHERE repo = ?`, path[1]);
			return json(
				commits.map((c: any) => ({
					...c,
					parents: JSON.parse(c.parents),
					trailers: trailers.filter((t: any) => t.sha === c.sha).map((t: any) => ({ [t.key]: t.value })),
				})),
			);
		}
		if (req.method === "GET" && path[0] === "traits" && path[1]) {
			return json(await all(`SELECT repo, sha FROM trailers WHERE key = 'Trait' AND value = ?`, path[1]));
		}
		if (req.method === "GET" && path[0] === "live" && path[1]) {
			// Same data straight from Artifacts through the Workers binding, for comparison.
			using repo = await env.ARTIFACTS.get(path[1]);
			const [info, log] = await Promise.all([repo.info(), repo.log({ limit: 5 })]);
			return json({ info, log });
		}
		if (req.method === "GET" && path[0] === "fs") {
			const ref = url.searchParams.get("ref") ?? "main";
			const filePath = url.searchParams.get("path") ?? "";

			// /fs/compare?path=src/index.ts&repos=a,b,c — which lineages share the same bytes for a file.
			if (path[1] === "compare") {
				const names = (url.searchParams.get("repos") ?? "").split(",").filter(Boolean);
				const rows = await Promise.all(
					names.map(async (name) => {
						using repo = await env.ARTIFACTS.get(name);
						const entry = await resolvePath(repo, ref, filePath);
						return { repo: name, blob: entry?.hash ?? null };
					}),
				);
				const groups: Record<string, string[]> = {};
				for (const r of rows) (groups[r.blob ?? "missing"] ??= []).push(r.repo);
				return json({ path: filePath, ref, variants: Object.keys(groups).length, groups });
			}

			using repo = await env.ARTIFACTS.get(path[1]);
			// /fs/:repo/file?ref=&path= — readFile resolves ref + path in one call.
			if (path[2] === "file") {
				const t0 = Date.now();
				const blob = await repo.readFile({ ref, path: filePath });
				if (!blob) return json({ error: "file not found", ref, path: filePath }, 404);
				return json({ ref, path: filePath, size: blob.size, type: blob.type, ms: Date.now() - t0, text: await blob.text() });
			}
			// /fs/:repo/tree?ref=&path= — walk trees from the commit's root tree.
			if (path[2] === "tree") {
				const entry = await resolvePath(repo, ref, filePath);
				if (!entry) return json({ error: "path not found" }, 404);
				if (entry.type !== "tree") return json({ error: "not a directory", entry }, 400);
				return json({ ref, path: filePath || "/", tree: entry.hash, entries: await repo.readTree(entry.hash) });
			}
			// /fs/:repo/blob/:hash — raw object by hash, immutable.
			if (path[2] === "blob" && path[3]) {
				const blob = await repo.readBlob(path[3]);
				return blob ? new Response(blob, { headers: { "content-type": "text/plain; charset=utf-8" } }) : json({ error: "no blob" }, 404);
			}
			// /fs/:repo/commit/:hash
			if (path[2] === "commit" && path[3]) {
				return json(await repo.readCommit(path[3]));
			}
		}
		if (req.method === "POST" && path[0] === "lineages") {
			if (req.headers.get("Authorization") !== `Bearer ${env.ADMIN_KEY}`) return json({ error: "unauthorized" }, 401);
			const { from, name } = (await req.json()) as { from: string; name: string };
			using source = await env.ARTIFACTS.get(from);
			const forked = await source.fork(name, { defaultBranchOnly: true, description: `lineage of ${from}` });
			const subscription = await subscribe(name);
			await env.DB.prepare(`INSERT OR IGNORE INTO repos VALUES (?, ?, ?)`).bind(name, `artifacts:${env.NAMESPACE}/${from}`, new Date().toISOString()).run();
			return json({ name: forked.name, remote: forked.remote, token: forked.token, subscription }, 201);
		}
		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
