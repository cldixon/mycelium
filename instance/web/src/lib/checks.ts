import type { ChecksEvaluation, RequiredChecks } from "$shared/types";
import { get, request, seg } from "$lib/api";

/** Client for required checks (/api/repos/:repo/checks, /pulls/:n/checks). */

const base = (repo: string) => `/api/repos/${seg(repo)}`;

export const checks = {
  required: (repo: string, branch?: string) =>
    get<RequiredChecks>(
      `${base(repo)}/checks/required${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`,
    ),
  setRequired: (repo: string, branch: string, workflows: string[]) =>
    request<RequiredChecks>("PUT", `${base(repo)}/checks/required`, { branch, workflows }),
  forPull: (repo: string, n: number) => get<ChecksEvaluation>(`${base(repo)}/pulls/${n}/checks`),
  runMissing: (repo: string, n: number) =>
    request<{
      started: { number: number; workflow: string }[];
      unavailable: string[];
      checks: ChecksEvaluation;
    }>("POST", `${base(repo)}/pulls/${n}/checks/run`),
};

/** Why the checks block a merge, or null when they don't. */
export function blockingReason(e: ChecksEvaluation | null): string | null {
  if (!e || e.satisfied) return null;
  const count = (s: string) => e.required.filter((c) => c.status === s).length;
  if (count("failure")) return "A required check failed. Fix it and push, or re-run it.";
  if (count("pending")) return "Waiting for required checks to finish.";
  return "Some required checks haven't run on this commit.";
}
