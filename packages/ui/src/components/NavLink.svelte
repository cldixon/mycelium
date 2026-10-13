<script lang="ts">
  import type { Snippet } from "svelte";

  /** A top-bar link. The current section is plain text weight 600, not a link look. */
  let {
    href,
    current = false,
    children,
  }: { href: string; current?: boolean; children: Snippet } = $props();
</script>

<a
  {href}
  aria-current={current ? "page" : undefined}
  class="whitespace-nowrap no-underline {current ? 'font-semibold' : 'text-muted hover:text-fg'}"
  >{@render children()}</a
>
