import type { MergeMethod, Pull, PullState } from "../shared/types.js";

/**
 * Pure rules for pull requests (no bindings), so they can be unit tested.
 */

export const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

export function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === "string" && (MERGE_METHODS as readonly string[]).includes(value);
}

/** `?state=` → the stored states it lists. Closed includes merged. */
export function statesFor(filter: string | undefined): PullState[] | null {
  switch (filter ?? "open") {
    case "open":
      return ["open"];
    case "closed":
      return ["closed", "merged"];
    case "all":
      return ["open", "closed", "merged"];
    default:
      return null;
  }
}

/** The commit message for merging `pull` with `method` (unused by rebase). */
export function defaultMergeMessage(
  pull: Pick<Pull, "number" | "title" | "body" | "head">,
  method: MergeMethod,
): string {
  if (method === "squash") {
    const body = pull.body.trim();
    return `${pull.title} (#${pull.number})${body ? `\n\n${body}` : ""}`;
  }
  return `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
}

/**
 * Who merge commits are by: the owner, by handle when known. There is no
 * real mailbox, so the email is a non-routable address on the instance host.
 */
export function ownerIdentity(
  handle: string | null,
  did: string,
  host: string,
): { name: string; email: string } {
  const local =
    (handle ?? did).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "owner";
  return { name: handle ?? did, email: `${local}@${host}` };
}

/** A branch name a pull request may use: like git's check-ref-format, roughly. */
export function isBranchName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.includes("@{") &&
    !/[\x00-\x20~^:?*[\\\x7f]/.test(name)
  );
}

const ZERO_SHA = /^0+$/;

/**
 * What a push means for pull requests: the branch it moved, its new tip, or
 * that it was deleted. Null for anything that isn't a branch (tags).
 */
export function branchUpdate(push: {
  ref: string;
  after: string | null;
}): { branch: string; sha: string | null } | null {
  if (!push.ref.startsWith("refs/heads/")) return null;
  const branch = push.ref.slice("refs/heads/".length);
  const deleted = !push.after || ZERO_SHA.test(push.after);
  return { branch, sha: deleted ? null : push.after };
}

/** Validate a PATCH body. Returns the changes, or an error message. */
export function pullPatch(
  body: unknown,
  current: Pick<Pull, "state">,
): { title?: string; body?: string; state?: "open" | "closed" } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const out: { title?: string; body?: string; state?: "open" | "closed" } = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string" || !b.title.trim()) return { error: "Title can't be empty" };
    out.title = b.title.trim().slice(0, 256);
  }
  if (b.body !== undefined) {
    if (typeof b.body !== "string") return { error: "Body must be text" };
    out.body = b.body.slice(0, 65536);
  }
  if (b.state !== undefined) {
    if (b.state !== "open" && b.state !== "closed")
      return { error: "State must be open or closed" };
    if (current.state === "merged") return { error: "A merged pull request can't change state" };
    out.state = b.state;
  }
  return out;
}
