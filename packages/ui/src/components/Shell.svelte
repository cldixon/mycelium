<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The frame every Mycelium page sits in: one top bar (brand, a few nav links,
   * the account menu), the page, and a footer. Kept to one line down to
   * phone width; the account menu holds everything that doesn't fit.
   */
  let {
    brand,
    nav,
    account,
    footer,
    children,
  }: {
    brand: Snippet;
    nav?: Snippet;
    account?: Snippet;
    footer?: Snippet;
    children: Snippet;
  } = $props();
</script>

<a
  href="#main"
  class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-bg focus:p-2"
  >Skip to content</a
>
<div class="flex min-h-dvh flex-col">
  <header class="border-b border-line">
    <div class="mx-auto flex max-w-page items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6">
      <div class="min-w-0 shrink truncate font-semibold">{@render brand()}</div>
      {#if nav}
        <nav aria-label="Main" class="flex items-center gap-4 text-meta">{@render nav()}</nav>
      {/if}
      <div class="ml-auto flex shrink-0 items-center gap-3">{@render account?.()}</div>
    </div>
  </header>
  <main id="main" class="mx-auto w-full max-w-page flex-1 px-4 py-6 sm:px-6 sm:py-8">
    {@render children()}
  </main>
  {#if footer}
    <footer class="border-t border-line-soft">
      <div class="mx-auto max-w-page px-4 py-4 text-meta text-muted sm:px-6">
        {@render footer()}
      </div>
    </footer>
  {/if}
</div>
