<script lang="ts">
  import type { FileDiff } from "$shared/types";
  import { plural } from "@mycelium/ui";

  /**
   * A pull request's changed files: a summary list, then each file's unified
   * diff. Local to the pulls routes (the Code feature has its own commit diff).
   */
  let { files, truncated = false }: { files: FileDiff[]; truncated?: boolean } = $props();

  let additions = $derived(files.reduce((n, f) => n + f.additions, 0));
  let deletions = $derived(files.reduce((n, f) => n + f.deletions, 0));

  type Line = { kind: "hunk" | "add" | "del" | "ctx" | "meta"; text: string };

  /** The patch without git's per-file header (diff --git, index, ---, +++). */
  function lines(patch: string): Line[] {
    const out: Line[] = [];
    let inHunk = false;
    for (const text of patch.split("\n")) {
      if (text.startsWith("@@")) {
        inHunk = true;
        out.push({ kind: "hunk", text });
      } else if (!inHunk) continue;
      else if (text.startsWith("+")) out.push({ kind: "add", text });
      else if (text.startsWith("-")) out.push({ kind: "del", text });
      else if (text.startsWith("\\")) out.push({ kind: "meta", text });
      else out.push({ kind: "ctx", text });
    }
    return out;
  }

  const anchor = (i: number) => `file-${i}`;
</script>

<div class="grid gap-4">
  <p class="text-meta text-muted">
    {plural(files.length, "file")} changed, <span class="data">+{additions} −{deletions}</span>
    {#if truncated}· some files were left out (the diff is too large){/if}
  </p>

  <ul class="grid gap-0.5">
    {#each files as file, i (file.path + i)}
      <li class="flex flex-wrap items-baseline gap-x-3">
        <span class="eyebrow w-16">{file.status}</span>
        <a href="#{anchor(i)}" class="data break-all">
          {#if file.oldPath}{file.oldPath} →
          {/if}{file.path}
        </a>
        <span class="data ml-auto text-muted">+{file.additions} −{file.deletions}</span>
      </li>
    {/each}
  </ul>

  {#each files as file, i (file.path + i)}
    <section id={anchor(i)} class="grid scroll-mt-4 border border-line-soft">
      <header class="flex flex-wrap items-baseline gap-x-3 border-b border-line-soft px-3 py-1.5">
        <span class="data font-semibold break-all"
          >{#if file.oldPath}{file.oldPath} →
          {/if}{file.path}</span
        >
        <span class="eyebrow">{file.status}</span>
        <span class="data ml-auto text-muted">+{file.additions} −{file.deletions}</span>
      </header>
      {#if file.binary}
        <p class="px-3 py-2 text-meta text-muted">Binary file not shown.</p>
      {:else if !file.patch}
        <p class="px-3 py-2 text-meta text-muted">
          {file.additions + file.deletions > 0 ? "Diff too large to show." : "No content changes."}
        </p>
      {:else}
        <div class="overflow-x-auto">
          <pre class="data m-0 py-1"><code
              >{#each lines(file.patch) as line, j (j)}<span
                  class="block px-3 {line.kind === 'hunk' || line.kind === 'meta'
                    ? 'bg-sunken text-muted'
                    : line.kind === 'add'
                      ? 'font-semibold'
                      : line.kind === 'del'
                        ? 'text-muted'
                        : ''}">{line.text || " "}</span
                >{/each}</code
            ></pre>
        </div>
      {/if}
    </section>
  {/each}
</div>
