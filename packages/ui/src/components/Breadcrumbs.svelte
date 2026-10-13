<script lang="ts">
  import type { Crumb } from "../types.js";

  /** Where this page sits: repo / path / file. Monospace, like a path. */
  let { items }: { items: Crumb[] } = $props();
</script>

<nav aria-label="Breadcrumb" class="data text-muted">
  {#each items as item, i (i)}
    {#if i > 0}<span aria-hidden="true">{" / "}</span>{/if}
    {#if item.href && i < items.length - 1}
      <a href={item.href}>{item.label}</a>
    {:else}
      <span aria-current={i === items.length - 1 ? "page" : undefined}>{item.label}</span>
    {/if}
  {/each}
</nav>
