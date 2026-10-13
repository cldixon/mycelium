<script lang="ts">
  import { page } from "$app/state";
  import { invalidateAll } from "$app/navigation";
  import { LiveIndicator, RepoHeader, type RepoTab } from "@mycelium/ui";
  import { liveFeed, onLive } from "$lib/live.svelte";

  let { data, children } = $props();

  /** The tab is the first path segment after the repo: /:repo/pulls/3 → pulls. */
  const TABS: Record<string, RepoTab> = {
    pulls: "pulls",
    actions: "actions",
    contributors: "contributors",
    settings: "settings",
  };
  let current = $derived<RepoTab>(TABS[page.route.id?.split("/")[2] ?? ""] ?? "code");

  // One live socket per repo, open on every repo page; pages listen on it.
  let live = $derived(liveFeed(data.repo.name));
  $effect(() => onLive(data.repo.name, ["repo"], () => invalidateAll()));
</script>

<svelte:head><title>{data.repo.name} · {data.status?.title ?? "mycelium"}</title></svelte:head>

<div class="grid gap-6">
  <RepoHeader
    handle={data.status?.handle}
    repo={data.repo.name}
    visibility={data.repo.visibility}
    owner={data.status?.signedIn ?? false}
    {current}
  >
    {#snippet aside()}<LiveIndicator status={live.status} />{/snippet}
  </RepoHeader>
  {@render children()}
</div>
