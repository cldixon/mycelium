import type { CommitInfo, FileDiff } from "../../../instance/src/shared/jobs.ts";
import type { Git } from "../git.ts";

/**
 * Shared by the `diff` and `merge` jobs (Pulls feature): resolving branch
 * names or shas against the cached clone, and parsing git's output.
 */

/** Caps, as in ARCHITECTURE.md "Diffs": 300 files, 1 MB of patch text. */
export const MAX_FILES = 300;
export const MAX_PATCH_BYTES = 1024 * 1024;
/** One file's patch beyond this is dropped (its counts are kept). */
export const MAX_FILE_PATCH_BYTES = 256 * 1024;
export const MAX_COMMITS = 250;

/**
 * The commit a job means by `name`: the remote branch `<remote>/<name>`
 * first, then any revision git understands (a sha).
 */
export async function resolveRev(git: Git, remote: string, name: string): Promise<string> {
  for (const rev of [`refs/remotes/${remote}/${name}`, name]) {
    if (rev.startsWith("-")) continue;
    const r = await git("rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
    if (r.code === 0 && r.out) return r.out;
  }
  throw new Error(`unknown branch or commit: ${name}`);
}

/** Undo git's C-style path quoting ("a\tb" → a<TAB>b, octal escapes for UTF-8). */
export function unquotePath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const s = path.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8 };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = s[i + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Strip the a/ or b/ prefix of a path in a diff header. "/dev/null" → null. */
function sidePath(raw: string): string | null {
  const p = unquotePath(raw.trim());
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/**
 * Split `git diff -M --no-color` output into per-file diffs with status and
 * line counts. Patches over `maxFileBytes` are emptied (counts stay); after
 * `maxFiles` files or `maxBytes` of patch text the rest is dropped and
 * `truncated` is set.
 */
export function parseUnifiedDiff(
  text: string,
  { maxFiles = MAX_FILES, maxBytes = MAX_PATCH_BYTES, maxFileBytes = MAX_FILE_PATCH_BYTES } = {},
): { files: FileDiff[]; truncated: boolean } {
  const files: FileDiff[] = [];
  let truncated = false;
  let bytes = 0;
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const lines = chunk.replace(/\n$/, "").split("\n");
    let status: FileDiff["status"] = "modified";
    let oldPath: string | null | undefined;
    let newPath: string | null | undefined;
    let binary = false;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of lines.slice(1)) {
      if (inHunk) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
        else if (line.startsWith("@@")) continue;
        continue;
      }
      if (line.startsWith("@@")) inHunk = true;
      else if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "deleted";
      else if (line.startsWith("rename from ")) {
        status = "renamed";
        oldPath = unquotePath(line.slice("rename from ".length));
      } else if (line.startsWith("rename to "))
        newPath = unquotePath(line.slice("rename to ".length));
      else if (line.startsWith("--- ")) oldPath ??= sidePath(line.slice(4));
      else if (line.startsWith("+++ ")) newPath ??= sidePath(line.slice(4));
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
    }
    if (newPath === undefined && oldPath === undefined) {
      // Binary or mode-only change: only the `diff --git a/x b/y` header names it.
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(lines[0]!);
      if (m) {
        oldPath = m[1]!;
        newPath = m[2]!;
      }
    }
    const path = (status === "deleted" ? oldPath : (newPath ?? oldPath)) ?? "";
    let patch = binary ? "" : chunk;
    const size = new TextEncoder().encode(patch).length;
    if (size > maxFileBytes) patch = "";
    else if (bytes + size > maxBytes) {
      patch = "";
      truncated = true;
    }
    bytes += patch.length;
    const file: FileDiff = { path, status, additions, deletions, binary, patch };
    if (status === "renamed" && oldPath) file.oldPath = oldPath;
    files.push(file);
  }
  return { files, truncated };
}

/** Log format for parseLog: fields split by NUL, records by RS (0x1e). */
export const LOG_FORMAT = "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B%x1e";

export function parseLog(out: string): CommitInfo[] {
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha, parents, name, email, date, ...msg] = r.split("\x00");
      return {
        sha: sha!,
        parents: parents ? parents.split(" ") : [],
        author: { name: name!, email: email!, date: date! },
        message: msg.join("\x00").trimEnd(),
      };
    });
}

/**
 * Conflicted paths from `git merge-tree --write-tree --name-only` output:
 * the first line is the tree, then conflicted paths until a blank line.
 */
export function parseMergeTree(out: string): { tree: string; conflicts: string[] } {
  const lines = out.split("\n");
  const tree = lines[0] ?? "";
  const conflicts: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === "") break;
    conflicts.push(unquotePath(line));
  }
  return { tree, conflicts: [...new Set(conflicts)] };
}

/** Keep text under `max` characters, saying how much was cut. */
export const clip = (s: string, max = 64 * 1024) =>
  s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
