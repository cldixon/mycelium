<script lang="ts">
  import { onMount } from "svelte";
  import type { ActivityItem } from "$shared/live";
  import {
    EmptyState,
    LiveIndicator,
    Loading,
    Notice,
    PageHeader,
    StatusIcon,
    plural,
    shortSha,
    timeAgo,
  } from "@mycelium/ui";
  import { activity, shortRef } from "$lib/activity";
  import { debounce, INSTANCE, liveFeed, onLive } from "$lib/live.svelte";

  let { data } = $props();

  let items = $state<ActivityItem[] | null>(null);
  let error = $state<string | null>(null);
  let now = $state(Date.now());

  async function load() {
    try {
      items = await activity.list(100);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    now = Date.now();
  }

  const live = liveFeed(INSTANCE);
  onMount(() => {
    load();
    // While the socket is down, refresh now and then instead.
    const timer = setInterval(() => live.status !== "live" && load(), 15_000);
    return () => clearInterval(timer);
  });
  $effect(() => onLive(INSTANCE, [], debounce(load, 200)));

  const ago = (iso: string) => {
    const t = timeAgo(iso, now);
    return /^\d+[smhdw]$/.test(t) ? `${t} ago` : t;
  };
  const repoHref = (repo: string) => `/${encodeURIComponent(repo)}`;
  const key = (i: ActivityItem) =>
    `${i.kind}:${i.repo}:${i.kind === "push" ? i.after : i.number}:${i.kind === "pull" ? i.action : ""}:${i.at}`;
</script>

<svelte:head><title>Activity · {data.status?.title ?? "mycelium"}</title></svelte:head>

<div class="grid gap-6">
  <PageHeader title="Activity" description="Pushes, pull requests and workflow runs, newest first.">
    {#snippet actions()}<LiveIndicator status={live.status} />{/snippet}
  </PageHeader>

  {#if error}
    <Notice tone="error" title="Couldn't load activity">{error}</Notice>
  {:else if items === null}
    <Loading />
  {:else if items.length === 0}
    <EmptyState title="Nothing yet">Pushes, pull requests and runs will show up here.</EmptyState>
  {:else}
    <ul class="grid" aria-label="Activity">
      {#each items as item (key(item))}
        <li class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-soft py-2">
          <a href={repoHref(item.repo)} class="font-semibold">{item.repo}</a>
          {#if item.kind === "push"}
            <span>
              pushed {plural(item.count, "commit")} to
              <span class="data">{shortRef(item.ref)}</span>
              {#if item.after && !/^0+$/.test(item.after)}
                · <a href="{repoHref(item.repo)}/commit/{item.after}" class="data"
                  >{shortSha(item.after)}</a
                >
              {/if}
            </span>
          {:else if item.kind === "pull"}
            <span>
              {item.action} pull request
              <a href="{repoHref(item.repo)}/pulls/{item.number}">#{item.number}</a>
              {item.title}
            </span>
          {:else}
            <span class="inline-flex items-baseline gap-1">
              <StatusIcon status={item.status} />
              <a href="{repoHref(item.repo)}/actions/runs/{item.number}"
                >{item.workflow} #{item.number}</a
              >
              <span class="text-muted">{item.status} · {item.event} on</span>
              <span class="data">{item.ref}</span>
            </span>
          {/if}
          <span class="data ml-auto text-muted">{ago(item.at)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
