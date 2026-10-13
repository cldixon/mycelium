<script lang="ts">
  import type { Snippet } from "svelte";
  import TabNav from "./TabNav.svelte";
  import type { RepoTab, TabItem } from "../types.js";

  /**
   * The top of every repo page: `handle / repo`, the visibility as plain
   * text, then the repo tabs. Settings is only shown to the owner.
   */
  let {
    handle,
    repo,
    visibility,
    current,
    owner = false,
    base,
    aside,
  }: {
    handle?: string | null;
    repo: string;
    visibility: "private" | "public";
    current: RepoTab;
    owner?: boolean;
    /** Where the repo's pages live. Defaults to `/<repo>`. */
    base?: string;
    /** Shown at the end of the title line (e.g. a LiveIndicator). */
    aside?: Snippet;
  } = $props();

  let root = $derived(base ?? `/${repo}`);
  let tabs = $derived<TabItem[]>([
    { id: "code", label: "Code", href: root },
    { id: "pulls", label: "Pull requests", href: `${root}/pulls` },
    { id: "actions", label: "Actions", href: `${root}/actions` },
    { id: "contributors", label: "Contributors", href: `${root}/contributors` },
    ...(owner ? [{ id: "settings", label: "Settings", href: `${root}/settings` }] : []),
  ]);
</script>

<header class="grid gap-3">
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h1 class="text-page break-words">
      {#if handle}<span class="text-muted">{handle}</span><span
          class="text-muted"
          aria-hidden="true">{" / "}</span
        >{/if}<a href={root} class="font-semibold no-underline">{repo}</a>
    </h1>
    <span class="eyebrow">{visibility}</span>
    {#if aside}<span class="ml-auto">{@render aside()}</span>{/if}
  </div>
  <TabNav items={tabs} {current} label="Repository" />
</header>
