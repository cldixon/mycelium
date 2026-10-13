// The runner container. The instance Worker sends typed jobs (see
// instance/src/shared/jobs.ts) to POST /jobs; each runs real git (and, for
// workflows, the repo's own commands) and answers JSON.
import type { Job } from "../../instance/src/shared/jobs.ts";
import { sh } from "./git.ts";
import { handlers } from "./jobs/index.ts";

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    return Response.json({
      ok: true,
      git: (await sh("/", ["git", "--version"])).out,
      bun: Bun.version,
    });
  }
  if (req.method === "POST" && url.pathname === "/jobs") {
    let job: Job;
    try {
      job = (await req.json()) as Job;
    } catch {
      return Response.json({ error: "body must be a JSON job" }, { status: 400 });
    }
    const handler = handlers[job?.type] as ((job: Job) => Promise<unknown>) | undefined;
    if (!handler)
      return Response.json({ error: `unknown job type: ${job?.type}` }, { status: 400 });
    const t0 = Date.now();
    try {
      const result = await handler(job);
      console.log(`job ${job.type} ok in ${Date.now() - t0} ms`);
      return Response.json(result);
    } catch (error) {
      console.error(`job ${job.type} failed`, error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

if (import.meta.main) {
  Bun.serve({ port: Number(process.env.PORT ?? 8080), fetch: handle });
  console.log("mycelium runner on :8080");
}
