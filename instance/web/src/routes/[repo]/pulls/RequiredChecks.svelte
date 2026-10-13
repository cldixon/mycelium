<script lang="ts">
  import type { ChecksEvaluation } from "$shared/types";
  import { Button, Notice, StatusIcon } from "@mycelium/ui";
  import { blockingReason, checks } from "$lib/checks";
  import { debounce, liveFeed, onLive } from "$lib/live.svelte";

  /**
   * The pull request's required checks (GET /pulls/:n/checks) as a
   * checklist, polled while any is pending. `blocking` is why they stop a
   * merge, or null. Renders nothing when the base branch requires none.
   */
  let {
    repo,
    number,
    headSha,
    owner,
    blocking = $bindable(null),
    workflows = $bindable([]),
  }: {
    repo: string;
    number: number;
    /** The head the page knows; a change reloads the checks. */
    headSha: string | null;
    owner: boolean;
    blocking?: string | null;
    /** The required workflows' names, so the merge box can leave them out of its other runs. */
    workflows?: string[];
  } = $props();

  let evaluation = $state<ChecksEvaluation | null>(null);
  let error = $state<string | null>(null);
  let starting = $state(false);
  let notice = $state<string | null>(null);

  const LABELS = {
    success: "passed",
    failure: "failed",
    pending: "in progress",
    missing: "not run",
  };

  async function load() {
    try {
      evaluation = await checks.forPull(repo, number);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void headSha;
    evaluation = null;
    load();
  });

  // Live: run events reload the checks.
  $effect(() => onLive(repo, ["run"], debounce(load, 200)));

  // Poll while a check is pending and the live socket is down.
  $effect(() => {
    if (liveFeed(repo).status === "live") return;
    if (!evaluation?.required.some((c) => c.status === "pending")) return;
    const timer = setTimeout(load, 4000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    blocking = blockingReason(evaluation);
    workflows = evaluation?.required.map((c) => c.workflow) ?? [];
  });

  let missing = $derived(evaluation?.required.filter((c) => c.status === "missing") ?? []);

  async function runMissing() {
    starting = true;
    notice = null;
    try {
      const result = await checks.runMissing(repo, number);
      evaluation = result.checks;
      if (result.unavailable.length) {
        notice = `Not on this commit: ${result.unavailable.join(", ")}`;
      }
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    } finally {
      starting = false;
    }
  }
</script>

{#if error}
  <Notice tone="error" title="Couldn't load required checks">{error}</Notice>
{:else if evaluation && evaluation.required.length > 0}
  <div class="grid gap-2" aria-label="Required checks">
    <p class="font-semibold">
      {evaluation.satisfied ? "All required checks have passed" : "Required checks"}
    </p>
    <ul class="grid gap-0.5">
      {#each evaluation.required as check (check.workflow)}
        <li class="flex flex-wrap items-baseline gap-x-3 text-meta">
          <StatusIcon status={check.status} />
          {#if check.runNumber}
            <a href="/{repo}/actions/runs/{check.runNumber}">{check.workflow}</a>
            <span class="data text-muted">#{check.runNumber}</span>
          {:else}
            <span>{check.workflow}</span>
          {/if}
          <span class="text-muted">{LABELS[check.status]} · required</span>
        </li>
      {/each}
    </ul>
    {#if owner && missing.length > 0}
      <div>
        <Button onclick={runMissing} disabled={starting}>
          {starting ? "Starting…" : "Run missing checks"}
        </Button>
      </div>
    {/if}
    {#if notice}<p class="text-meta text-muted">{notice}</p>{/if}
  </div>
{/if}
