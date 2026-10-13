<script lang="ts">
  /** A quiet loading line. Announced politely; no spinner yet. */
  let { label = "Loading…" }: { label?: string } = $props();
</script>

<p role="status" class="text-meta text-muted">{label}</p>
