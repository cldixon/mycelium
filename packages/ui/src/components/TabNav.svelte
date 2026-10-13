<script lang="ts">
  import type { TabItem } from "../types.js";

  /**
   * Page-level tabs as links, so every tab has a URL that can be shared and
   * is server-rendered. Disabled tabs are reserved for later phases.
   */
  let {
    items,
    current,
    label = "Sections",
  }: { items: TabItem[]; current: string; label?: string } = $props();
</script>

<nav aria-label={label} class="relative overflow-x-auto border-b border-line">
  <ul class="flex gap-5 whitespace-nowrap">
    {#each items as tab (tab.id)}
      <li>
        {#if tab.disabled}
          <span class="inline-block py-1.5 text-muted" title="Not available yet"
            >{tab.label}{#if tab.count != null}&nbsp;({tab.count}){/if}</span
          >
        {:else}
          <a
            href={tab.href}
            aria-current={tab.id === current ? "page" : undefined}
            class="-mb-px inline-block border-b-2 py-1.5 no-underline {tab.id === current
              ? 'border-fg font-semibold'
              : 'border-transparent text-muted hover:text-fg'}"
            >{tab.label}{#if tab.count != null}&nbsp;({tab.count}){/if}</a
          >
        {/if}
      </li>
    {/each}
  </ul>
</nav>
