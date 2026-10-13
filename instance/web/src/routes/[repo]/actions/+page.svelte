<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import type { RefInfo, Run, WorkflowList } from "$shared/types";
  import {
    Button,
    EmptyState,
    Loading,
    Notice,
    Section,
    StatusIcon,
    shortSha,
    timeAgo,
  } from "@mycelium/ui";
  import { actions, duration, isActive, poll } from "$lib/actions";
  import { debounce, liveFeed, onLive } from "$lib/live.svelte";

  let { data } = $props();
  let repo = $derived(data.repo.name);
  let owner = $derived(data.status?.signedIn ?? false);

  let runs = $state<Run[] | null>(null);
  let runsError = $state<string | null>(null);
  let list = $state<WorkflowList | null>(null);
  let listError = $state<string | null>(null);
  let branches = $state<RefInfo[]>([]);
  let now = $state(Date.now());

  /** The workflow whose Run form is open, its ref, and the request in flight. */
  let running = $state<string | null>(null);
  let ref = $state("");
  let busy = $state(false);
  let startError = $state<string | null>(null);

  async function loadRuns() {
    try {
      runs = await actions.runs(repo);
      runsError = null;
    } catch (e) {
      runsError = e instanceof Error ? e.message : String(e);
    }
    now = Date.now();
  }

  function loadWorkflows() {
    actions
      .workflows(repo)
      .then((w) => ((list = w), (listError = null)))
      .catch((e) => (listError = e instanceof Error ? e.message : String(e)));
    if (owner) actions.refs(repo).then((r) => (branches = r?.branches ?? []));
  }

  onMount(() => {
    loadRuns();
    loadWorkflows();
    // Polling is the fallback while the live socket is down.
    return poll(
      loadRuns,
      () => liveFeed(repo).status !== "live" && (runs?.some((r) => isActive(r.status)) ?? false),
    );
  });
  $effect(() => onLive(repo, ["run"], debounce(loadRuns, 150)));
  // A push (or a reconnect) may change the workflow files and branches.
  $effect(() =>
    onLive(
      repo,
      ["push"],
      debounce(() => (loadWorkflows(), loadRuns()), 300),
    ),
  );

  function open(workflow: string) {
    running = running === workflow ? null : workflow;
    ref = list?.ref ?? data.repo.defaultBranch;
    startError = null;
  }

  async function start(event: SubmitEvent) {
    event.preventDefault();
    if (!running) return;
    busy = true;
    startError = null;
    try {
      const run = await actions.start(repo, running, ref || undefined);
      await goto(`/${repo}/actions/runs/${run.number}`);
    } catch (e) {
      startError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid gap-8">
  <Section title="Runs">
    {#if runsError}
      <Notice tone="error" title="Couldn't load runs">{runsError}</Notice>
    {:else if runs === null}
      <Loading />
    {:else if runs.length === 0}
      <EmptyState title="No runs yet">
        Add a workflow file under <code class="data">.mycelium/workflows/</code> and push, or run one
        below.
      </EmptyState>
    {:else}
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th><span class="sr-only">Status</span></th>
              <th>Run</th>
              <th>Event</th>
              <th>Ref</th>
              <th>Started</th>
              <th class="num">Duration</th>
            </tr>
          </thead>
          <tbody>
            {#each runs as run (run.number)}
              <tr>
                <td class="w-6"><StatusIcon status={run.status} /></td>
                <td>
                  <a href="/{repo}/actions/runs/{run.number}">{run.workflow} #{run.number}</a>
                </td>
                <td class="nowrap">
                  {run.event}{#if run.pullNumber}
                    · <a href="/{repo}/pulls/{run.pullNumber}">#{run.pullNumber}</a>{/if}
                </td>
                <td class="data nowrap">
                  {run.ref} · <a href="/{repo}/commit/{run.sha}">{shortSha(run.sha)}</a>
                </td>
                <td class="data nowrap text-muted">
                  {run.startedAt ? timeAgo(run.startedAt, now) : run.status}
                </td>
                <td class="data num">{duration(run.startedAt, run.finishedAt, now)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Section>

  <Section
    title="Workflows"
    description={list?.sha
      ? `Files in .mycelium/workflows at ${list.ref} (${shortSha(list.sha)}).`
      : undefined}
  >
    {#if listError}
      <Notice tone="error" title="Couldn't read workflows">{listError}</Notice>
    {:else if list === null}
      <Loading />
    {:else}
      {#each list.errors as e (e.path)}
        <Notice tone="error" title={e.path}>{e.error}</Notice>
      {/each}
      {#if list.workflows.length === 0 && list.errors.length === 0}
        <EmptyState title="No workflows">
          Workflows are YAML files in <code class="data">.mycelium/workflows/</code>, e.g.
          <code class="data">on: [push]</code> and a list of <code class="data">steps</code> with
          <code class="data">run</code> commands.
        </EmptyState>
      {:else}
        <ul class="grid">
          {#each list.workflows as wf (wf.path)}
            <li class="grid gap-2 border-b border-line-soft py-3">
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span class="font-semibold">{wf.name}</span>
                <span class="data text-muted">{wf.path}</span>
                <span class="text-meta text-muted">
                  on {[...wf.on.filter((e) => e !== "manual"), "manual"].join(", ")} · {wf.steps
                    .length}
                  {wf.steps.length === 1 ? "step" : "steps"}
                </span>
                {#if owner}
                  <span class="ml-auto">
                    <Button
                      size="sm"
                      onclick={() => open(wf.name)}
                      aria-expanded={running === wf.name}
                    >
                      Run workflow
                    </Button>
                  </span>
                {/if}
              </div>
              {#if running === wf.name}
                <form class="flex flex-wrap items-end gap-2" onsubmit={start}>
                  <label class="grid gap-1 text-meta">
                    <span>Branch, tag or commit</span>
                    <input
                      class="input data w-64"
                      list="refs-{wf.name}"
                      bind:value={ref}
                      required
                      autocomplete="off"
                    />
                    <datalist id="refs-{wf.name}">
                      {#each branches as b (b.name)}<option value={b.name}></option>{/each}
                    </datalist>
                  </label>
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy ? "Starting…" : "Run"}
                  </Button>
                </form>
                {#if startError}<Notice tone="error">{startError}</Notice>{/if}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </Section>
</div>
