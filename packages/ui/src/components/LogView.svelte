<script lang="ts">
  /**
   * Command output: monospace, whitespace kept, numbered lines, scrolls
   * sideways instead of wrapping. Empty logs say so.
   */
  let {
    log,
    empty = "No output.",
    maxHeight = "32rem",
  }: { log: string; empty?: string; maxHeight?: string } = $props();

  let lines = $derived(log.replace(/\n$/, "").split("\n"));
</script>

{#if log === ""}
  <p class="text-meta text-muted">{empty}</p>
{:else}
  <div class="overflow-auto border border-line-soft bg-sunken" style:max-height={maxHeight}>
    <table class="data w-full border-collapse">
      <tbody>
        {#each lines as line, i (i)}
          <tr>
            <td class="w-px select-none px-2 text-right align-top text-muted">{i + 1}</td>
            <td class="pr-2 align-top whitespace-pre">{line}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
