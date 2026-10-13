import { parse as parseYaml } from "yaml";
import type { RunEvent, Workflow, WorkflowStep } from "../shared/types.js";

/**
 * Workflow files: `.mycelium/workflows/*.yml` (or `.yaml`).
 *
 *   name: test                    # optional; defaults to the file name
 *   on: [push, pull_request]      # a string or a list of push | pull_request | manual
 *   timeout-minutes: 10           # optional; whole run, at most 10
 *   steps:
 *     - name: Test                # optional; defaults to the command's first line
 *       run: bun test
 *       timeout-minutes: 2        # optional; this step
 *
 * `manual` runs are always allowed, whatever `on` says.
 */

export const WORKFLOW_DIR = ".mycelium/workflows";
export const EVENTS: readonly RunEvent[] = ["push", "pull_request", "manual"];
/** Default and maximum whole-run timeout. */
export const MAX_TIMEOUT_SEC = 600;
export const MAX_STEPS = 50;
/** Workflow files larger than this are refused. */
export const MAX_FILE_BYTES = 64 * 1024;

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
}

/** True for a path the workflow loader reads. */
export function isWorkflowFile(name: string): boolean {
  return /^[^/]+\.ya?ml$/.test(name) && !name.startsWith(".");
}

/** The default workflow name: the file name without `.yml`/`.yaml`. */
export function baseName(path: string): string {
  return path
    .split("/")
    .pop()!
    .replace(/\.ya?ml$/, "");
}

const fail = (message: string): never => {
  throw new WorkflowParseError(message);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `timeout-minutes` as whole seconds, validated. */
function timeoutOf(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${where}timeout-minutes must be a positive number`);
  }
  return Math.max(1, Math.round((value as number) * 60));
}

function parseOn(value: unknown): RunEvent[] {
  if (value === undefined || value === null) fail('missing "on" (push, pull_request or manual)');
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0) {
    fail('"on" must be an event name or a list of them (push, pull_request, manual)');
  }
  const out: RunEvent[] = [];
  for (const event of list as unknown[]) {
    if (typeof event !== "string" || !EVENTS.includes(event as RunEvent)) {
      fail(`unknown event ${JSON.stringify(event)} in "on" (use push, pull_request or manual)`);
    }
    if (!out.includes(event as RunEvent)) out.push(event as RunEvent);
  }
  return out;
}

function parseStep(value: unknown, i: number): WorkflowStep {
  const where = `steps[${i}]: `;
  if (typeof value === "string") value = { run: value };
  if (!isRecord(value)) fail(`${where}must be a mapping with "run"`);
  const step = value as Record<string, unknown>;
  for (const key of Object.keys(step)) {
    if (!["name", "run", "timeout-minutes"].includes(key)) fail(`${where}unknown key "${key}"`);
  }
  if (typeof step.run !== "string" || step.run.trim() === "") {
    fail(`${where}"run" must be a non-empty string`);
  }
  if (step.name !== undefined && (typeof step.name !== "string" || step.name.trim() === "")) {
    fail(`${where}"name" must be a non-empty string`);
  }
  const run = step.run as string;
  const name = (step.name as string | undefined)?.trim() ?? run.trim().split("\n")[0]!.slice(0, 80);
  const timeoutSec = timeoutOf(step["timeout-minutes"], where);
  return timeoutSec === undefined ? { name, run } : { name, run, timeoutSec };
}

/**
 * Parse and validate one workflow file. Throws WorkflowParseError with a
 * message fit for the UI.
 */
export function parseWorkflow(path: string, text: string): Workflow {
  if (text.length > MAX_FILE_BYTES) fail(`file is larger than ${MAX_FILE_BYTES / 1024} KB`);
  let doc: unknown;
  try {
    doc = parseYaml(text, { prettyErrors: true, uniqueKeys: true });
  } catch (error) {
    fail(`invalid YAML: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
  if (!isRecord(doc)) fail("expected a mapping with on and steps");
  const wf = doc as Record<string, unknown>;
  for (const key of Object.keys(wf)) {
    if (!["name", "on", "steps", "timeout-minutes"].includes(key)) fail(`unknown key "${key}"`);
  }
  let name = baseName(path);
  if (wf.name !== undefined) {
    if (typeof wf.name !== "string" || wf.name.trim() === "") {
      fail('"name" must be a non-empty string');
    }
    name = (wf.name as string).trim();
  }
  if (name.length > 100) fail('"name" is longer than 100 characters');
  const on = parseOn(wf.on);
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) fail('"steps" must be a non-empty list');
  const rawSteps = wf.steps as unknown[];
  if (rawSteps.length > MAX_STEPS) fail(`more than ${MAX_STEPS} steps`);
  const steps = rawSteps.map(parseStep);
  const timeoutSec = Math.min(
    timeoutOf(wf["timeout-minutes"], "") ?? MAX_TIMEOUT_SEC,
    MAX_TIMEOUT_SEC,
  );
  return { path, name, on, steps, timeoutSec };
}

/** Does `workflow` run for `event`? Manual runs are always allowed. */
export function runsOn(workflow: Pick<Workflow, "on">, event: RunEvent): boolean {
  return event === "manual" || workflow.on.includes(event);
}
