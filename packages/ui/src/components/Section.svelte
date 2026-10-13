<script lang="ts">
  import type { Snippet } from "svelte";

  /** A titled block of a page. The title is a plain h2; actions sit on its right. */
  let {
    title,
    id,
    description,
    actions,
    children,
  }: {
    title?: string;
    id?: string;
    description?: string;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<section {id} class="grid scroll-mt-4 gap-3">
  {#if title || actions}
    <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {#if title}<h2 class="text-title font-semibold">{title}</h2>{/if}
      {#if actions}<div class="ml-auto flex items-center gap-3 text-meta">
          {@render actions()}
        </div>{/if}
    </div>
  {/if}
  {#if description}<p class="max-w-reading text-meta text-muted">{description}</p>{/if}
  {@render children()}
</section>
