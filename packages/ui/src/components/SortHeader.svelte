<script lang="ts">
  /** A sortable column header. aria-sort tells assistive tech the current order. */
  let {
    label,
    active,
    descending,
    numeric = false,
    onclick,
  }: {
    label: string;
    active: boolean;
    descending: boolean;
    numeric?: boolean;
    onclick: () => void;
  } = $props();
</script>

<th
  scope="col"
  class={numeric ? "num" : ""}
  aria-sort={active ? (descending ? "descending" : "ascending") : "none"}
>
  <button type="button" class="font-semibold" {onclick}
    >{label}{#if active}<span aria-hidden="true">{descending ? " ↓" : " ↑"}</span>{/if}</button
  >
</th>
