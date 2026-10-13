<script lang="ts">
  import { page } from "$app/state";
  import { EmptyState } from "@mycelium/ui";
</script>

<EmptyState title={page.status === 404 ? "Not found" : "Something went wrong"}>
  {page.error?.message ?? ""}
  {#snippet action()}<a href="/">Back to repositories</a>{/snippet}
</EmptyState>
