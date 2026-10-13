<script lang="ts">
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";

  /** Copy a value (a URL, a command, a hash) with one click. */
  let { value, label = "copy" }: { value: string; label?: string } = $props();
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard refused (insecure origin, permissions); the value stays visible.
    }
  }
</script>

<button
  type="button"
  onclick={copy}
  class="inline-flex items-center gap-1 underline underline-offset-2"
  aria-live="polite"
>
  {#if copied}<Check size={12} aria-hidden="true" />copied{:else}<Copy
      size={12}
      aria-hidden="true"
    />{label}{/if}
</button>
