<script lang="ts">
  import { goto } from "$app/navigation";
  import type { CommitSummary } from "$shared/types";
  import { BranchSelect, EmptyState, formatDate, shortSha, timeAgo } from "@mycelium/ui";
  import { links } from "$lib/code";

  let { data } = $props();

  let repo = $derived(data.repo.name);

  /** Commits grouped by day (newest first), like a log. */
  let days = $derived.by(() => {
    const groups: { day: string; commits: CommitSummary[] }[] = [];
    for (const c of data.list.commits) {
      const day = formatDate(c.committedAt);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.commits.push(c);
      else groups.push({ day, commits: [c] });
    }
    return groups;
  });

  const pageUrl = (n: number) => `${links.commits(repo, data.ref)}${n > 1 ? `?page=${n}` : ""}`;
</script>

<svelte:head><title>Commits · {data.ref} · {repo}</title></svelte:head>

<div class="grid gap-4">
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <BranchSelect
      branches={data.refs.branches.map((b) => b.name)}
      tags={data.refs.tags.map((t) => t.name)}
      value={data.ref}
      onchange={(r) => goto(links.commits(repo, r))}
    />
    <h2 class="text-title font-semibold">Commits</h2>
    <a href={links.tree(repo, data.ref)} class="ml-auto text-meta">Browse files</a>
  </div>

  {#if data.list.commits.length === 0}
    <EmptyState title="No more commits">
      <a href={pageUrl(1)}>Back to the newest</a>
    </EmptyState>
  {:else}
    {#each days as group (group.day)}
      <section class="grid gap-1">
        <h3 class="eyebrow">Commits on {group.day}</h3>
        <ul class="grid border-t border-line">
          {#each group.commits as c (c.sha)}
            <li class="grid gap-0.5 border-b border-line-soft py-2">
              <div class="flex flex-wrap items-baseline gap-x-3">
                <a href={links.commit(repo, c.sha)} class="min-w-0 font-semibold break-words"
                  >{c.title}</a
                >
                <span class="data ml-auto flex gap-3">
                  <a href={links.commit(repo, c.sha)}>{shortSha(c.sha)}</a>
                  <a href={links.tree(repo, c.sha)} class="text-muted">files</a>
                </span>
              </div>
              <p class="text-meta text-muted">
                {c.author.name} committed {timeAgo(c.committedAt)}
              </p>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}

  <nav aria-label="Pagination" class="flex gap-4 text-meta">
    {#if data.page > 1}<a href={pageUrl(data.page - 1)}>← Newer</a>{/if}
    {#if data.list.hasMore}<a href={pageUrl(data.page + 1)}>Older →</a>{/if}
  </nav>
</div>
