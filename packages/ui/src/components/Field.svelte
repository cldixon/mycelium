<script lang="ts">
  import type { Snippet } from "svelte";

  /** A labelled form control, with an optional hint under it and an error. */
  let {
    label,
    hint,
    error,
    children,
  }: {
    label: string;
    hint?: string | Snippet;
    error?: string | null;
    children: Snippet;
  } = $props();
</script>

<label class="grid gap-1">
  <span class="text-meta">{label}</span>
  {@render children()}
  {#if typeof hint === "string"}
    <span class="text-meta text-muted">{hint}</span>
  {:else if hint}
    <span class="text-meta text-muted">{@render hint()}</span>
  {/if}
  {#if error}<span class="text-meta font-semibold" role="alert">{error}</span>{/if}
</label>
