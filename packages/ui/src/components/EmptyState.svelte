<script lang="ts">
  import type { Snippet } from "svelte";

  /** Nothing here yet: a short title, a sentence, and the next step. */
  let { title, children, action }: { title: string; children?: Snippet; action?: Snippet } =
    $props();
</script>

<div class="grid justify-items-start gap-2 border border-dashed border-line px-5 py-8">
  <p class="font-semibold">{title}</p>
  {#if children}<div class="max-w-reading text-meta text-muted">{@render children()}</div>{/if}
  {#if action}<div class="pt-1">{@render action()}</div>{/if}
</div>
