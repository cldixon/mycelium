<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { RunDetail } from "$shared/types";
  import {
    Actor,
    Button,
    Loading,
    LogView,
    MetaList,
    Notice,
    PageHeader,
    StatusIcon,
    formatDateTime,
    shortSha,
  } from "@mycelium/ui";
  import { actions, duration, isActive, poll } from "$lib/actions";

  let { data } = $props();
  let repo = $derived(data.repo.name);
  let number = $derived(Number(page.params.number));
  let owner = $derived(data.status?.signedIn ?? false);

  let run = $state<RunDetail | null>(null);
  let error = $state<string | null>(null);
  let now = $state(Date.now());
  let busy = $state(false);
  /** Steps the viewer opened or closed by hand (otherwise: open when not a success). */
  let toggled = $state<Record<number, boolean>>({});

  async function load() {
    try {
      run = await actions.run(repo, number);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    now = Date.now();
  }

  onMount(() => {
    load();
    return poll(load, () => (run ? isActive(run.status) : false), 2000);
  });

  async function rerun() {
    busy = true;
    try {
      const next = await actions.rerun(repo, number);
      await goto(`/${repo}/actions/runs/${next.number}`);
      toggled = {};
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const isOpen = (idx: number, status: string) =>
    toggled[idx] ?? !["success", "pending", "skipped"].includes(status);
</script>

<div class="grid gap-6">
  {#if error && !run}
    <Notice tone="error" title="Couldn't load run #{number}">{error}</Notice>
  {:else if run === null}
    <Loading />
  {:else}
    <PageHeader title="{run.workflow} #{run.number}">
      {#snippet crumbs()}<a href="/{repo}/actions" class="text-meta">← Actions</a>{/snippet}
      {#snippet status()}<StatusIcon status={run!.status} label />{/snippet}
      {#snippet actions()}
        {#if owner && !isActive(run!.status)}
          <Button onclick={rerun} disabled={busy}>{busy ? "Starting…" : "Re-run"}</Button>
        {/if}
      {/snippet}
    </PageHeader>
    {#if error}<Notice tone="error">{error}</Notice>{/if}

    <MetaList
      rows={[
        {
          label: "Event",
          value: run.pullNumber ? `${run.event} (#${run.pullNumber})` : run.event,
          href: run.pullNumber ? `/${repo}/pulls/${run.pullNumber}` : null,
        },
        { label: "Ref", value: run.ref, mono: true },
        {
          label: "Commit",
          value: shortSha(run.sha),
          href: `/${repo}/commit/${run.sha}`,
          mono: true,
        },
        { label: "Queued", value: formatDateTime(run.createdAt), mono: true },
        { label: "Started", value: formatDateTime(run.startedAt), mono: true },
        { label: "Duration", value: duration(run.startedAt, run.finishedAt, now), mono: true },
      ]}
    />
    {#if run.actor}
      <p class="text-meta text-muted">
        Started by <Actor name={run.actor.name} kind={run.actor.kind} />
      </p>
    {/if}

    <section class="grid gap-2" aria-label="Steps">
      <h2 class="text-title font-semibold">Steps</h2>
      {#each run.steps as step (step.idx)}
        <details
          class="border-b border-line-soft py-2"
          open={isOpen(step.idx, step.status)}
          ontoggle={(e) => {
            const open = (e.currentTarget as HTMLDetailsElement).open;
            if (open !== isOpen(step.idx, step.status)) toggled[step.idx] = open;
          }}
        >
          <summary class="flex cursor-pointer flex-wrap items-baseline gap-x-3">
            <StatusIcon status={step.status} />
            <span class="font-semibold">{step.name}</span>
            {#if step.exitCode !== null && step.exitCode !== 0}
              <span class="data text-muted">exit {step.exitCode}</span>
            {/if}
            <span class="data ml-auto text-muted">
              {step.startedAt ? duration(step.startedAt, step.finishedAt, now) : step.status}
            </span>
          </summary>
          <div class="grid gap-2 pt-2">
            <pre class="data whitespace-pre-wrap text-muted">$ {step.command}</pre>
            <LogView
              log={step.log}
              empty={step.status === "running"
                ? "Running… output appears when the run finishes."
                : step.status === "pending" || step.status === "skipped"
                  ? "Didn't run."
                  : "No output."}
            />
          </div>
        </details>
      {/each}
    </section>
  {/if}
</div>
