import type { PingJob, PingResult } from "../../../instance/src/shared/jobs.ts";
import { sh } from "../git.ts";

/** Is the container up, and which git and bun does it have? */
export async function ping(_job: PingJob): Promise<PingResult> {
  return { ok: true, git: (await sh("/", ["git", "--version"])).out, bun: Bun.version };
}
