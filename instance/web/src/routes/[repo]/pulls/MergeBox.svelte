<script lang="ts">
  import type { DiffResult, MergeMethod, Pull } from "$shared/types";
  import { Button, Field, Loading, Notice, plural } from "@mycelium/ui";
  import { mergeOrConflict, runsFor, type RunSummary } from "$lib/pulls";

  /**
   * Merge an open pull request: mergeability from the diff, workflow runs
   * for the head commit (when the Actions feature is there), the method, and
   * the conflict report when a merge fails.
   */
  let {
    repo,
    pull,
    diff,
    diffError,
    owner,
    onMerged,
  }: {
    repo: string;
    pull: Pull;
    diff: DiffResult | null;
    diffError: string | null;
    owner: boolean;
    onMerged: () => void;
  } = $props();

  const METHODS: { id: MergeMethod; label: string; hint: string }[] = [
    { id: "merge", label: "Create a merge commit", hint: "All commits, plus a merge commit." },
    { id: "squash", label: "Squash and merge", hint: "One commit with all the changes." },
    {
      id: "rebase",
      label: "Rebase and merge",
      hint: "Head's commits replayed on top of base, no merge commit.",
    },
  ];
  let method = $state<MergeMethod>("merge");
  let message = $state("");
  let merging = $state(false);
  let error = $state<string | null>(null);
  let conflict = $state<{ files: string[]; diff: string } | null>(null);

  // --- Workflow runs (slot for the Actions feature: GET /runs?sha=) ---------
  let runs = $state<RunSummary[] | null>(null);
  $effect(() => {
    const sha = diff?.headSha ?? pull.headSha;
    runs = null;
    if (sha) runsFor(repo, sha).then((r) => (runs = r));
  });

  async function merge() {
    merging = true;
    error = null;
    conflict = null;
    const result = await mergeOrConflict(repo, pull.number, {
      method,
      message: message.trim() || undefined,
      headSha: diff?.headSha,
    });
    merging = false;
    if ("pull" in result) onMerged();
    else if ("conflict" in result) conflict = result.conflict;
    else error = result.error;
  }
</script>

<section class="grid gap-3 border border-line p-4" aria-label="Merge">
  <!-- Workflow run status: shown only when the Actions feature answers /runs?sha= -->
  {#if runs && runs.length > 0}
    <ul class="grid gap-0.5" aria-label="Workflow runs">
      {#each runs as run (run.number)}
        <li class="flex flex-wrap items-baseline gap-x-3 text-meta">
          <span class="eyebrow w-16">{run.status}</span>
          <a href="/{repo}/actions/runs/{run.number}">{run.workflow}</a>
          <span class="data text-muted">#{run.number}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if diffError}
    <Notice tone="error" title="Couldn't check this pull request">{diffError}</Notice>
  {:else if !diff}
    <Loading label="Checking mergeability… (the runner can take half a minute to start)" />
  {:else if diff.ahead === 0}
    <p class="font-semibold">Nothing to merge</p>
    <p class="text-meta text-muted">{pull.base} already has every commit in {pull.head}.</p>
  {:else if diff.mergeable}
    <p class="font-semibold">This branch has no conflicts with {pull.base}</p>
    <p class="text-meta text-muted">
      {plural(diff.ahead, "commit")} to merge{#if diff.behind > 0}; {pull.base} is {plural(
          diff.behind,
          "commit",
        )} ahead of {pull.head}{/if}.
    </p>
  {:else}
    <p class="font-semibold">This branch has conflicts that must be resolved</p>
    <p class="text-meta text-muted">
      Merge {pull.base} into {pull.head} locally, fix them, and push. Conflicting:
      <span class="data">{diff.conflicts.join(", ")}</span>
    </p>
  {/if}

  {#if owner && diff && diff.ahead > 0}
    <div class="grid max-w-form gap-3">
      <Field label="Merge method" hint={METHODS.find((m) => m.id === method)?.hint}>
        <select class="input" bind:value={method}>
          {#each METHODS as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
        </select>
      </Field>
      {#if method !== "rebase"}
        <Field label="Commit message" hint="Optional. Leave empty for the default.">
          <textarea class="input" rows="2" bind:value={message}></textarea>
        </Field>
      {/if}
      <div>
        <Button variant="primary" onclick={merge} disabled={merging || !diff.mergeable}>
          {merging ? "Merging…" : (METHODS.find((m) => m.id === method)?.label ?? "Merge")}
        </Button>
      </div>
    </div>
  {/if}

  {#if error}<Notice tone="error" title="Couldn't merge">{error}</Notice>{/if}
  {#if conflict}
    <Notice tone="error" title="Merge conflict: nothing was pushed">
      Conflicting files: <span class="data">{conflict.files.join(", ")}</span>
    </Notice>
    {#if conflict.diff}
      <details>
        <summary class="text-meta">Show the conflict</summary>
        <pre class="data overflow-x-auto bg-sunken p-3">{conflict.diff}</pre>
      </details>
    {/if}
  {/if}
</section>
