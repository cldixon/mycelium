<script lang="ts">
  import Bot from "@lucide/svelte/icons/bot";

  /**
   * Who did something: the owner's name as plain text, or an agent's name
   * with a small bot icon (and "agent" for screen readers), so an agent's
   * work never reads as the owner's.
   */
  let { name, kind = "owner" }: { name: string; kind?: "owner" | "agent" | string } = $props();
</script>

{#if kind === "agent"}<span
    class="inline-flex items-center gap-1 align-baseline"
    title="agent {name}"
    data-actor="agent"
    ><Bot size={14} aria-hidden="true" class="flex-none self-center" /><span class="sr-only"
      >agent</span
    >{name}</span
  >{:else}<span data-actor="owner">{name}</span>{/if}
