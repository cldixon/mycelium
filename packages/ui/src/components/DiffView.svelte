<script module lang="ts">
  /** One hunk of a unified diff; lines start with " ", "+", "-" or "\\". */
  export type DiffViewHunk = {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  };
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * One file's unified diff: a header (path, status, counts, actions) and its
   * hunks with old and new line numbers. Without hunks, `note` explains why
   * (binary, too large, mode change only).
   */
  let {
    path,
    status,
    additions = 0,
    deletions = 0,
    hunks,
    note,
    actions,
    id,
  }: {
    path: string;
    status?: string;
    additions?: number;
    deletions?: number;
    hunks: DiffViewHunk[] | null;
    note?: string;
    actions?: Snippet;
    id?: string;
  } = $props();

  type Row =
    | { kind: "hunk"; text: string }
    | { kind: "line"; sign: string; old: number | null; new: number | null; text: string };

  let rows = $derived.by(() => {
    const out: Row[] = [];
    for (const h of hunks ?? []) {
      out.push({
        kind: "hunk",
        text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      });
      let o = h.oldStart;
      let n = h.newStart;
      for (const line of h.lines) {
        const sign = line[0] ?? " ";
        const text = line.slice(1);
        if (sign === "+") out.push({ kind: "line", sign, old: null, new: n++, text });
        else if (sign === "-") out.push({ kind: "line", sign, old: o++, new: null, text });
        else if (sign === "\\") out.push({ kind: "line", sign, old: null, new: null, text });
        else out.push({ kind: "line", sign: " ", old: o++, new: n++, text });
      }
    }
    return out;
  });
</script>

<section {id} class="grid scroll-mt-4 border border-line-soft" aria-label={path}>
  <header
    class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-soft bg-sunken px-3 py-1.5"
  >
    <span class="data font-semibold break-all">{path}</span>
    {#if status}<span class="eyebrow">{status}</span>{/if}
    <span class="data text-muted">+{additions} −{deletions}</span>
    {#if actions}<span class="ml-auto text-meta">{@render actions()}</span>{/if}
  </header>
  {#if hunks && hunks.length > 0}
    <div class="table-scroll">
      <table class="diff data">
        <tbody>
          {#each rows as row, i (i)}
            {#if row.kind === "hunk"}
              <tr class="hunk">
                <td colspan="4" class="text-muted">{row.text}</td>
              </tr>
            {:else}
              <tr class:add={row.sign === "+"} class:del={row.sign === "-"}>
                <td class="num text-muted">{row.old ?? ""}</td>
                <td class="num text-muted">{row.new ?? ""}</td>
                <td class="sign" aria-hidden={row.sign === " " ? "true" : undefined}
                  >{row.sign === "-" ? "−" : row.sign === "\\" ? "" : row.sign}</td
                >
                <td class="line" class:text-muted={row.sign === "\\"}>{row.text}</td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="px-3 py-2 text-meta text-muted">{note ?? "No content changes."}</p>
  {/if}
</section>

<style>
  .diff {
    border-collapse: collapse;
    width: 100%;
  }
  .num {
    width: 1%;
    padding: 0 0.5rem;
    text-align: right;
    user-select: none;
    vertical-align: top;
  }
  .sign {
    width: 1%;
    padding: 0 0.25rem;
    user-select: none;
    font-weight: 600;
  }
  .line {
    padding: 0 0.75rem 0 0.25rem;
    white-space: pre;
    tab-size: 4;
  }
  .hunk td {
    padding: 0.125rem 0.5rem;
    border-top: 1px solid var(--line-soft);
    border-bottom: 1px solid var(--line-soft);
  }
  .add,
  .del {
    background: var(--sunken);
  }
</style>
