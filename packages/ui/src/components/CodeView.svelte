<script lang="ts">
  /**
   * A text file with line numbers. Each number links to `#L<n>`, and the
   * targeted line is marked, so a line can be shared by URL.
   */
  let { text, label = "File contents" }: { text: string; label?: string } = $props();

  let lines = $derived.by(() => {
    const all = text.split("\n");
    if (all.length > 1 && all[all.length - 1] === "") all.pop();
    return all;
  });
</script>

<div class="table-scroll border border-line-soft">
  <table class="code data" aria-label={label}>
    <tbody>
      {#each lines as line, i (i)}
        <tr id="L{i + 1}">
          <td class="num select-none text-muted">
            <a href="#L{i + 1}" class="no-underline hover:underline">{i + 1}</a>
          </td>
          <td class="line">{line}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .code {
    border-collapse: collapse;
    width: 100%;
  }
  .num {
    width: 1%;
    padding: 0 0.75rem 0 0.5rem;
    text-align: right;
    vertical-align: top;
    border-right: 1px solid var(--line-soft);
  }
  .line {
    padding: 0 0.75rem;
    white-space: pre;
    tab-size: 4;
  }
  tr:target {
    background: var(--sunken);
  }
</style>
