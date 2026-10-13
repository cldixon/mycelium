<script lang="ts">
  import { onMount } from "svelte";
  import type { Repo } from "$shared/types";
  import { EmptyState, Loading, Notice, PageHeader, timeAgo } from "@mycelium/ui";
  import { repos } from "$lib/api";

  let { data } = $props();

  let list = $state<Repo[] | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      list = await repos.list();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });
</script>

<div class="grid gap-6">
  <PageHeader title="Repositories" />

  {#if error}
    <Notice tone="error" title="Couldn't load repositories">{error}</Notice>
  {:else if list === null}
    <Loading />
  {:else if list.length === 0}
    <EmptyState title="No repositories yet">
      {#if data.status?.signedIn}
        Create an empty repository or import one from a public git URL.
      {:else}
        Nothing public here. <a href="/signin">Sign in</a> if this is your instance.
      {/if}
    </EmptyState>
  {:else}
    <ul class="grid">
      {#each list as repo (repo.name)}
        <li class="grid gap-1 border-b border-line-soft py-3">
          <div class="flex flex-wrap items-baseline gap-x-3">
            <a href="/{repo.name}" class="font-semibold">{repo.name}</a>
            <span class="eyebrow">{repo.visibility}</span>
            <span class="data ml-auto text-muted">updated {timeAgo(repo.updatedAt)}</span>
          </div>
          {#if repo.description}<p class="text-meta text-muted">{repo.description}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
