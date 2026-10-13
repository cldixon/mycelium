<script lang="ts">
  import { renderMarkdown } from "../markdown.js";

  /**
   * A README rendered from markdown. `resolve` maps relative links and images
   * to URLs (for example, blob routes in the same repo).
   */
  let { markdown, resolve }: { markdown: string; resolve?: (path: string) => string } = $props();

  let html = $derived(renderMarkdown(markdown, resolve));
</script>

<!-- Rendered by renderMarkdown, which escapes raw HTML and unsafe links. -->
<div class="prose">{@html html}</div>
