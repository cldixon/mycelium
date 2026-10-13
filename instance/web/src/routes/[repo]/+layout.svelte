<script lang="ts">
  import { page } from "$app/state";
  import { RepoHeader, type RepoTab } from "@mycelium/ui";

  let { data, children } = $props();

  /** The tab is the first path segment after the repo: /:repo/pulls/3 → pulls. */
  const TABS: Record<string, RepoTab> = {
    pulls: "pulls",
    actions: "actions",
    contributors: "contributors",
    settings: "settings",
  };
  let current = $derived<RepoTab>(TABS[page.route.id?.split("/")[2] ?? ""] ?? "code");
</script>

<svelte:head><title>{data.repo.name} · {data.status?.title ?? "mycelium"}</title></svelte:head>

<div class="grid gap-6">
  <RepoHeader
    handle={data.status?.handle}
    repo={data.repo.name}
    visibility={data.repo.visibility}
    owner={data.status?.signedIn ?? false}
    {current}
  />
  {@render children()}
</div>
