<script lang="ts">
  import { invalidate } from "$app/navigation";
  import type { DiffResult } from "$shared/types";
  import {
    Actor,
    Button,
    EmptyState,
    Field,
    Loading,
    Notice,
    PageHeader,
    Readme,
    TabNav,
    plural,
  } from "@mycelium/ui";
  import { ago, pulls } from "$lib/pulls";
  import PullFiles from "../PullFiles.svelte";
  import PullCommits from "../PullCommits.svelte";
  import MergeBox from "../MergeBox.svelte";
  import { debounce, onLive } from "$lib/live.svelte";

  let { data } = $props();

  let repo = $derived(data.repo.name);
  let pull = $derived(data.pull);
  let owner = $derived(data.status?.signedIn ?? false);
  let root = $derived(`/${repo}/pulls/${pull.number}`);

  // The diff comes from the runner (slow on a cold start), so it loads after the page.
  let diff = $state<DiffResult | null>(null);
  let diffError = $state<string | null>(null);
  $effect(() => {
    const key = [repo, pull.number, pull.state, pull.headSha] as const;
    diff = null;
    diffError = null;
    pulls
      .diff(key[0], key[1])
      .then((d) => (diff = d))
      .catch((e) => (diffError = e instanceof Error ? e.message : String(e)));
  });

  let tabs = $derived([
    { id: "conversation", label: "Conversation", href: root, count: data.comments.length },
    { id: "commits", label: "Commits", href: `${root}?tab=commits`, count: diff?.commits.length },
    { id: "files", label: "Files changed", href: `${root}?tab=files`, count: diff?.files.length },
  ]);

  let comment = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  const reload = () => invalidate("mycelium:pull");

  // Live: this pull request's events (and reconnects) reload it.
  const liveReload = debounce(reload);
  $effect(() => {
    const n = pull.number;
    return onLive(repo, ["pull"], (m) => {
      if (!m || (m.type === "pull" && m.number === n)) liveReload();
    });
  });

  async function act(fn: () => Promise<unknown>) {
    busy = true;
    error = null;
    try {
      await fn();
      await reload();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function postComment(event: SubmitEvent) {
    event.preventDefault();
    await act(async () => {
      await pulls.comment(repo, pull.number, comment);
      comment = "";
    });
  }

  const setState = (state: "open" | "closed") =>
    act(() => pulls.update(repo, pull.number, { state }));
</script>

<div class="grid gap-6">
  <PageHeader title="{pull.title} #{pull.number}">
    {#snippet status()}<span class="eyebrow">{pull.state}</span>{/snippet}
    {#snippet meta()}
      <Actor name={pull.author} kind={pull.authorKind} />
      {#if pull.state === "merged"}
        merged <span class="data">{pull.head}</span> into <span class="data">{pull.base}</span>
        {pull.mergedAt ? ago(pull.mergedAt) : ""}
        {#if pull.mergeSha}(<a href="/{repo}/commit/{pull.mergeSha}" class="data"
            >{pull.mergeSha.slice(0, 7)}</a
          >, {pull.mergeMethod}){/if}
      {:else}
        wants to merge <span class="data">{pull.head}</span> into
        <span class="data">{pull.base}</span> · opened {ago(pull.createdAt)}
      {/if}
    {/snippet}
  </PageHeader>

  <TabNav items={tabs} current={data.tab} label="Pull request" />

  {#if data.tab === "conversation"}
    <div class="grid max-w-reading gap-4">
      <article class="grid gap-2 border-b border-line-soft pb-4">
        <p class="text-meta text-muted">
          <Actor name={pull.author} kind={pull.authorKind} /> · {ago(pull.createdAt)}
        </p>
        {#if pull.body.trim()}
          <Readme markdown={pull.body} />
        {:else}
          <p class="text-meta text-muted">No description.</p>
        {/if}
      </article>

      {#each data.comments as c (c.id)}
        <article class="grid gap-2 border-b border-line-soft pb-4">
          <p class="text-meta text-muted">
            <Actor name={c.author} kind={c.authorKind} /> · {ago(c.createdAt)}
          </p>
          <Readme markdown={c.body} />
        </article>
      {/each}

      {#if pull.state === "open"}
        <MergeBox {repo} {pull} {diff} {diffError} {owner} onMerged={reload} />
      {:else if pull.state === "merged"}
        <Notice tone="success" title="Merged">
          {pull.head} was merged into {pull.base} ({pull.mergeMethod}).
        </Notice>
      {:else}
        <Notice title="Closed">This pull request was closed without merging.</Notice>
      {/if}

      {#if error}<Notice tone="error" title="That didn't work">{error}</Notice>{/if}

      {#if owner}
        <form class="grid gap-3" onsubmit={postComment}>
          <Field label="Comment" hint="Markdown.">
            <textarea class="input" rows="4" bind:value={comment}></textarea>
          </Field>
          <div class="flex flex-wrap gap-2">
            <Button variant="primary" type="submit" disabled={busy || !comment.trim()}>
              Comment
            </Button>
            {#if pull.state === "open"}
              <Button onclick={() => setState("closed")} disabled={busy}>Close pull request</Button>
            {:else if pull.state === "closed"}
              <Button onclick={() => setState("open")} disabled={busy}>Reopen pull request</Button>
            {/if}
          </div>
        </form>
      {/if}
    </div>
  {:else if diffError}
    <Notice tone="error" title="Couldn't load the diff">{diffError}</Notice>
  {:else if !diff}
    <Loading label="Loading the diff… (the runner can take half a minute to start)" />
  {:else if data.tab === "commits"}
    {#if diff.commits.length === 0}
      <EmptyState title="No commits">{pull.head} has nothing that {pull.base} doesn't.</EmptyState>
    {:else}
      <p class="text-meta text-muted">
        {plural(diff.ahead, "commit")} on {pull.head}{#if diff.ahead > diff.commits.length}
          (showing the first {diff.commits.length}){/if}.
      </p>
      <PullCommits {repo} commits={diff.commits} />
    {/if}
  {:else if diff.files.length === 0}
    <EmptyState title="No changes">The branches have the same content.</EmptyState>
  {:else}
    <PullFiles files={diff.files} truncated={diff.truncated} />
  {/if}
</div>
