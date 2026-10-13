<script lang="ts">
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import type { DiffResult } from "$shared/types";
  import { Button, Field, Loading, Notice, PageHeader, Section, plural } from "@mycelium/ui";
  import { pulls } from "$lib/pulls";
  import PullFiles from "../PullFiles.svelte";
  import PullCommits from "../PullCommits.svelte";

  let { data } = $props();

  let base = $state(untrack(() => data.base));
  let head = $state(untrack(() => data.head));
  let title = $state("");
  let body = $state("");
  let preview = $state<DiffResult | null>(null);
  let previewError = $state<string | null>(null);
  let comparing = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Compare whenever the branches change; ignore answers for an older pair.
  let ticket = 0;
  $effect(() => {
    const pair = [base, head] as const;
    preview = null;
    previewError = null;
    if (!pair[0] || !pair[1] || pair[0] === pair[1]) return;
    const mine = ++ticket;
    comparing = true;
    pulls
      .compare(data.repo.name, pair[0], pair[1])
      .then((d) => {
        if (mine !== ticket) return;
        preview = d;
        if (!title && d.commits.length === 1) {
          title = d.commits[0]!.message.split("\n", 1)[0] ?? "";
        }
      })
      .catch((e) => mine === ticket && (previewError = e instanceof Error ? e.message : String(e)))
      .finally(() => mine === ticket && (comparing = false));
  });

  async function create(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    error = null;
    try {
      const pull = await pulls.create(data.repo.name, { title, body, head, base });
      await goto(`/${data.repo.name}/pulls/${pull.number}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<div class="grid gap-6">
  <PageHeader
    title="New pull request"
    description="Choose the branch with your changes (head) and the branch to merge it into (base)."
  />

  {#if !data.status?.signedIn}
    <Notice title="Sign in to open a pull request">Only the owner can open pull requests.</Notice>
  {:else if data.branches.length < 2}
    <Notice title="Nothing to compare">
      This repository has {plural(data.branches.length, "branch", "branches")}. Push another branch
      first.
    </Notice>
  {:else}
    <div class="grid max-w-form gap-3 sm:grid-cols-2">
      <Field label="Base (merge into)">
        <select class="input" bind:value={base}>
          {#each data.branches as name (name)}<option value={name}>{name}</option>{/each}
        </select>
      </Field>
      <Field label="Head (your changes)">
        <select class="input" bind:value={head}>
          {#each data.branches as name (name)}<option value={name}>{name}</option>{/each}
        </select>
      </Field>
    </div>

    {#if base === head}
      <Notice>Pick two different branches.</Notice>
    {:else if comparing}
      <Loading label="Comparing… (the runner can take half a minute to start)" />
    {:else if previewError}
      <Notice tone="error" title="Couldn't compare">{previewError}</Notice>
    {:else if preview}
      {#if preview.ahead === 0}
        <Notice title="Nothing to merge">{base} already has everything in {head}.</Notice>
      {:else}
        <p class="text-meta">
          {plural(preview.ahead, "commit")} ahead, {plural(preview.behind, "commit")} behind {base}.
          {preview.mergeable
            ? "Able to merge."
            : `Can't merge automatically: ${preview.conflicts.join(", ")} conflict.`}
        </p>
        <form class="grid max-w-reading gap-3" onsubmit={create}>
          <Field label="Title"><input class="input" bind:value={title} required /></Field>
          <Field label="Description" hint="Markdown.">
            <textarea class="input" rows="6" bind:value={body}></textarea>
          </Field>
          {#if error}<Notice tone="error" title="Couldn't open the pull request">{error}</Notice
            >{/if}
          <div>
            <Button variant="primary" type="submit" disabled={saving || !title.trim()}>
              {saving ? "Opening…" : "Open pull request"}
            </Button>
          </div>
        </form>
        <Section title="Commits">
          <PullCommits repo={data.repo.name} commits={preview.commits} />
        </Section>
        <Section title="Files changed">
          <PullFiles files={preview.files} truncated={preview.truncated} />
        </Section>
      {/if}
    {/if}
  {/if}
</div>
