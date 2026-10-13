<script lang="ts">
  import { Button, EmptyState, TabNav, personName } from "@mycelium/ui";
  import { ago } from "$lib/pulls";

  let { data } = $props();
  const who = (author: string) =>
    personName(author, { did: data.status?.owner, handle: data.status?.handle });

  let root = $derived(`/${data.repo.name}/pulls`);
  let tabs = $derived([
    { id: "open", label: "Open", href: root, count: data.list.counts.open },
    { id: "closed", label: "Closed", href: `${root}?state=closed`, count: data.list.counts.closed },
  ]);
</script>

<div class="grid gap-4">
  <div class="flex flex-wrap items-end gap-4">
    <div class="min-w-0 flex-1">
      <TabNav items={tabs} current={data.state} label="Pull request state" />
    </div>
    {#if data.status?.signedIn}
      <Button variant="primary" href="{root}/new">New pull request</Button>
    {/if}
  </div>

  {#if data.list.pulls.length === 0}
    <EmptyState title={data.state === "open" ? "No open pull requests" : "No closed pull requests"}>
      A pull request proposes merging one branch into another.
      {#if data.status?.signedIn}Push a branch, then open one.{/if}
    </EmptyState>
  {:else}
    <ul class="grid">
      {#each data.list.pulls as pull (pull.number)}
        <li class="grid gap-1 border-b border-line-soft py-3">
          <div class="flex flex-wrap items-baseline gap-x-3">
            <a href="{root}/{pull.number}" class="font-semibold">{pull.title}</a>
            <span class="eyebrow">{pull.state}</span>
          </div>
          <p class="text-meta text-muted">
            #{pull.number} · <span class="data">{pull.head}</span> into
            <span class="data">{pull.base}</span> · opened {ago(pull.createdAt)} by
            {who(pull.author)}
            {#if pull.mergedAt}· merged {ago(pull.mergedAt)}{:else if pull.closedAt}· closed {ago(
                pull.closedAt,
              )}{/if}
          </p>
        </li>
      {/each}
    </ul>
  {/if}
</div>
