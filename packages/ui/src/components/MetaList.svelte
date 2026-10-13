<script lang="ts">
  /** Key/value facts as a two-column table: review summaries, instance stats. */
  type Row = { label: string; value: string; href?: string | null; mono?: boolean };
  let { rows }: { rows: Row[] } = $props();
</script>

<div class="table-scroll">
  <table class="table">
    <tbody>
      {#each rows as row (row.label)}
        <tr>
          <th scope="row" class="w-36 font-normal text-muted">{row.label}</th>
          <td class={row.mono ? "data break-all" : ""}>
            {#if row.href}<a href={row.href}>{row.value}</a>{:else}{row.value}{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  /* Row headers sit in the body, so they get soft dividers like the cells. */
  th {
    border-bottom: 1px solid var(--line-soft) !important;
  }
</style>
