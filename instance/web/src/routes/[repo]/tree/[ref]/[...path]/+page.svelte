<script lang="ts">
  import CodeTree from "$lib/CodeTree.svelte";

  let { data } = $props();
</script>

<CodeTree
  repo={data.repo.name}
  refs={data.refs}
  ref={data.ref}
  listing={data.listing}
  readme={data.readme}
/>
