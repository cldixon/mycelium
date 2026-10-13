import type { Job, JobResult } from "../../../instance/src/shared/jobs.ts";
import { diff } from "./diff.ts";
import { merge } from "./merge.ts";
import { ping } from "./ping.ts";

/**
 * Job handlers by type. Each feature adds its handler in its own file
 * (`diff.ts`, `merge.ts`, `workflow.ts`) and one line here.
 */
type Handlers = {
  [T in Job["type"]]?: (
    job: Extract<Job, { type: T }>,
  ) => Promise<JobResult<Extract<Job, { type: T }>>>;
};

export const handlers: Handlers = {
  ping,
  diff,
  merge,
};
