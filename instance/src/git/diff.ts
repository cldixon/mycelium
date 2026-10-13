import { structuredPatch } from "diff";
import type { CommitFileDiff, DiffHunk, FileChangeStatus } from "../shared/types.js";

/**
 * Commit diffs in the Worker: a recursive tree diff (only descending into
 * subtrees whose hashes differ) and a line diff of each changed blob with the
 * `diff` package. Works against anything that reads trees and blobs by hash,
 * so tests use an in-memory reader instead of the Artifacts binding.
 */

export type TreeItem = { name: string; mode: string; hash: string; type: string };

export interface GitReader {
  readTree(hash: string): Promise<TreeItem[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
}

/** A changed path between two trees (directories expanded to their files). */
export type TreeChange = {
  path: string;
  status: FileChangeStatus;
  oldMode: string | null;
  newMode: string | null;
  oldSha: string | null;
  newSha: string | null;
  /** "gitlink" entries are submodule commits, not blobs. */
  oldType: string | null;
  newType: string | null;
};

export type DiffLimits = {
  /** Files listed at most (the rest are counted, not shown). */
  maxFiles: number;
  /** Blob bytes read and diffed per commit, in total. */
  maxBytes: number;
  /** Bytes of one file (both sides together) above which it isn't diffed. */
  maxFileBytes: number;
};

export const DEFAULT_LIMITS: DiffLimits = {
  maxFiles: 300,
  maxBytes: 1024 * 1024,
  maxFileBytes: 512 * 1024,
};

const isTree = (e: TreeItem) => e.type === "tree";
const join = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name);

async function readTreeOrEmpty(reader: GitReader, hash: string | null): Promise<TreeItem[]> {
  if (!hash) return [];
  const tree = await reader.readTree(hash);
  if (!tree) throw new Error(`tree ${hash} not found`);
  return tree;
}

/** Every file under `hash`, as added (or deleted) changes. */
async function expand(
  reader: GitReader,
  hash: string,
  prefix: string,
  status: "added" | "deleted",
): Promise<TreeChange[]> {
  const entries = await readTreeOrEmpty(reader, hash);
  const nested = await Promise.all(
    entries.map((e) =>
      isTree(e)
        ? expand(reader, e.hash, join(prefix, e.name), status)
        : Promise.resolve([fileChange(join(prefix, e.name), status, e)]),
    ),
  );
  return nested.flat();
}

function fileChange(path: string, status: "added" | "deleted", e: TreeItem): TreeChange {
  return status === "added"
    ? {
        path,
        status,
        oldMode: null,
        newMode: e.mode,
        oldSha: null,
        newSha: e.hash,
        oldType: null,
        newType: e.type,
      }
    : {
        path,
        status,
        oldMode: e.mode,
        newMode: null,
        oldSha: e.hash,
        newSha: null,
        oldType: e.type,
        newType: null,
      };
}

/**
 * The files that differ between two trees, sorted by path. `oldTree` null
 * means an empty tree (a root commit). A path that turns from a file into a
 * directory (or back) shows as a delete plus adds.
 */
export async function diffTrees(
  reader: GitReader,
  oldTree: string | null,
  newTree: string | null,
  prefix = "",
): Promise<TreeChange[]> {
  if (oldTree === newTree) return [];
  const [before, after] = await Promise.all([
    readTreeOrEmpty(reader, oldTree),
    readTreeOrEmpty(reader, newTree),
  ]);
  const old = new Map(before.map((e) => [e.name, e]));
  const now = new Map(after.map((e) => [e.name, e]));
  const names = [...new Set([...old.keys(), ...now.keys()])];

  const parts = await Promise.all(
    names.map(async (name): Promise<TreeChange[]> => {
      const a = old.get(name);
      const b = now.get(name);
      const path = join(prefix, name);
      if (a && b && a.hash === b.hash && a.mode === b.mode) return [];
      if (a && b && isTree(a) && isTree(b)) return diffTrees(reader, a.hash, b.hash, path);
      const out: TreeChange[] = [];
      if (a && b && !isTree(a) && !isTree(b)) {
        return [
          {
            path,
            status: "modified",
            oldMode: a.mode,
            newMode: b.mode,
            oldSha: a.hash,
            newSha: b.hash,
            oldType: a.type,
            newType: b.type,
          },
        ];
      }
      if (a)
        out.push(
          ...(isTree(a)
            ? await expand(reader, a.hash, path, "deleted")
            : [fileChange(path, "deleted", a)]),
        );
      if (b)
        out.push(
          ...(isTree(b)
            ? await expand(reader, b.hash, path, "added")
            : [fileChange(path, "added", b)]),
        );
      return out;
    }),
  );
  return parts.flat().sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** Git's heuristic: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

export type LineDiff = { hunks: DiffHunk[]; additions: number; deletions: number };

/**
 * A unified line diff (3 lines of context). Null when the diff gives up
 * (too many edits to compute cheaply).
 */
export function lineDiff(
  oldText: string,
  newText: string,
  maxEditLength = 20_000,
): LineDiff | null {
  const patch = structuredPatch("a", "b", oldText, newText, undefined, undefined, {
    context: 3,
    maxEditLength,
  });
  if (!patch) return null;
  let additions = 0;
  let deletions = 0;
  const hunks = patch.hunks.map((h) => {
    for (const line of h.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    return {
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    };
  });
  return { hunks, additions, deletions };
}

const decoder = new TextDecoder("utf-8");

type Side = { bytes: Uint8Array; size: number } | null;

async function readSide(reader: GitReader, sha: string | null, type: string | null): Promise<Side> {
  if (!sha) return { bytes: new Uint8Array(), size: 0 };
  if (type === "gitlink") {
    const bytes = new TextEncoder().encode(`Subproject commit ${sha}\n`);
    return { bytes, size: bytes.length };
  }
  const blob = await reader.readBlob(sha);
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), size: blob.size };
}

export type CommitDiff = {
  files: CommitFileDiff[];
  totalFiles: number;
  truncated: boolean;
  additions: number;
  deletions: number;
};

/**
 * Diff two root trees down to lines. Files past `maxFiles` are counted but not
 * listed; files past the byte budgets are listed without hunks (`tooLarge`).
 */
export async function diffCommitTrees(
  reader: GitReader,
  oldTree: string | null,
  newTree: string,
  limits: DiffLimits = DEFAULT_LIMITS,
): Promise<CommitDiff> {
  const changes = await diffTrees(reader, oldTree, newTree);
  const shown = changes.slice(0, limits.maxFiles);
  let budget = limits.maxBytes;
  const files: CommitFileDiff[] = [];

  // Read blobs a few files at a time; spend the byte budget in path order.
  const BATCH = 8;
  for (let i = 0; i < shown.length; i += BATCH) {
    const batch = shown.slice(i, i + BATCH);
    const sides = await Promise.all(
      batch.map((ch) =>
        budget <= 0
          ? Promise.resolve(null)
          : Promise.all([
              readSide(reader, ch.oldSha, ch.oldType),
              readSide(reader, ch.newSha, ch.newType),
            ]),
      ),
    );
    batch.forEach((ch, j) => {
      const base: CommitFileDiff = {
        path: ch.path,
        status: ch.status,
        oldMode: ch.oldMode,
        newMode: ch.newMode,
        oldSha: ch.oldSha,
        newSha: ch.newSha,
        binary: false,
        tooLarge: false,
        additions: 0,
        deletions: 0,
        hunks: null,
      };
      const pair = sides[j];
      if (!pair || !pair[0] || !pair[1]) {
        files.push({ ...base, tooLarge: true });
        return;
      }
      const [a, b] = pair as [NonNullable<Side>, NonNullable<Side>];
      if (isBinary(a.bytes) || isBinary(b.bytes)) {
        files.push({ ...base, binary: true });
        return;
      }
      const size = a.size + b.size;
      if (size > limits.maxFileBytes || size > budget) {
        files.push({ ...base, tooLarge: true });
        return;
      }
      budget -= size;
      const d = lineDiff(decoder.decode(a.bytes), decoder.decode(b.bytes));
      if (!d) {
        files.push({ ...base, tooLarge: true });
        return;
      }
      files.push({ ...base, ...d });
    });
  }

  return {
    files,
    totalFiles: changes.length,
    truncated: changes.length > shown.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}
