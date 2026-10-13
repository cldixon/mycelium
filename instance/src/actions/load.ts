import type { Bindings } from "../api/bindings.js";
import { withRepo } from "../git/artifacts.js";
import type { Workflow, WorkflowError } from "../shared/types.js";
import { MAX_FILE_BYTES, WORKFLOW_DIR, isWorkflowFile, parseWorkflow } from "./parse.js";

export type LoadedWorkflows = { workflows: Workflow[]; errors: WorkflowError[] };

/** The subset of ArtifactsRepo the loader needs (so tests can fake it). */
export type TreeReader = Pick<ArtifactsRepo, "readCommit" | "readTree" | "readBlob">;

/**
 * Every workflow file at commit `sha`, parsed. Files that fail to parse land
 * in `errors`; so do duplicate names (the first file, by path, wins).
 */
export async function readWorkflows(repo: TreeReader, sha: string): Promise<LoadedWorkflows> {
  const commit = await repo.readCommit(sha);
  if (!commit) throw new Error(`no commit ${sha}`);
  let hash = commit.treeHash;
  for (const segment of WORKFLOW_DIR.split("/")) {
    const entry = (await repo.readTree(hash))?.find((e) => e.name === segment);
    if (!entry || entry.type !== "tree") return { workflows: [], errors: [] };
    hash = entry.hash;
  }
  const files = ((await repo.readTree(hash)) ?? [])
    .filter((e) => (e.type === "blob" || e.type === "exec") && isWorkflowFile(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out: LoadedWorkflows = { workflows: [], errors: [] };
  const texts = await Promise.all(
    files.map(async (f): Promise<{ error: string } | { text: string }> => {
      const blob = await repo.readBlob(f.hash);
      if (!blob) return { error: "could not read the file" };
      if (blob.size > MAX_FILE_BYTES) {
        return { error: `file is larger than ${MAX_FILE_BYTES / 1024} KB` };
      }
      return { text: await blob.text() };
    }),
  );
  files.forEach((f, i) => {
    const path = `${WORKFLOW_DIR}/${f.name}`;
    const read = texts[i]!;
    if ("error" in read) {
      out.errors.push({ path, error: read.error });
      return;
    }
    const text = read.text;
    try {
      const wf = parseWorkflow(path, text);
      const dup = out.workflows.find((w) => w.name === wf.name);
      if (dup) out.errors.push({ path, error: `name "${wf.name}" is already used by ${dup.path}` });
      else out.workflows.push(wf);
    } catch (error) {
      out.errors.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return out;
}

/** readWorkflows through the Artifacts binding. */
export function loadWorkflows(
  env: Pick<Bindings, "ARTIFACTS">,
  repo: string,
  sha: string,
): Promise<LoadedWorkflows> {
  return withRepo(env, repo, (r) => readWorkflows(r, sha));
}
