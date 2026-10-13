<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The top of a page: optional breadcrumb, title, description, a meta line,
   * and an actions column that drops below the text on narrow screens.
   */
  let {
    title,
    eyebrow,
    description,
    crumbs,
    status,
    meta,
    actions,
  }: {
    title: string;
    eyebrow?: string;
    description?: string | null;
    crumbs?: Snippet;
    status?: Snippet;
    meta?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<header class="grid gap-3">
  {@render crumbs?.()}
  <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
    <div class="grid min-w-0 gap-2">
      {#if eyebrow}<span class="eyebrow">{eyebrow}</span>{/if}
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 class="text-page font-semibold break-words">{title}</h1>
        {@render status?.()}
      </div>
      {#if description}<p class="max-w-reading">{description}</p>{/if}
      {#if meta}<div class="text-meta text-muted">{@render meta()}</div>{/if}
    </div>
    {#if actions}<div class="grid gap-2 md:min-w-48">{@render actions()}</div>{/if}
  </div>
</header>
