<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * A message about what just happened or why something can't happen.
   * Errors are announced to screen readers.
   */
  let {
    tone = "info",
    title,
    children,
    actions,
  }: {
    tone?: "info" | "success" | "error";
    title?: string;
    children?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<div
  role={tone === "error" ? "alert" : "status"}
  class="grid gap-1 border-l-2 py-1 pl-3 {tone === 'error' ? 'border-danger' : 'border-line'}"
>
  {#if title}<p class="font-semibold">{title}</p>{/if}
  {#if children}<div class="text-meta">{@render children()}</div>{/if}
  {#if actions}<div class="flex flex-wrap gap-2 pt-1">{@render actions()}</div>{/if}
</div>
