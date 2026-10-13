<script lang="ts">
  import { goto } from "$app/navigation";
  import {
    BranchSelect,
    Breadcrumbs,
    CodeView,
    EmptyState,
    formatBytes,
    plural,
  } from "@mycelium/ui";
  import { links, pathCrumbs, rawUrl } from "$lib/code";

  let { data } = $props();

  let repo = $derived(data.repo.name);
  let blob = $derived(data.blob);
  let raw = $derived(rawUrl(repo, data.ref, blob.path));
  let lineCount = $derived(
    blob.text === null ? 0 : blob.text.split("\n").length - (blob.text.endsWith("\n") ? 1 : 0),
  );
  let sizeLine = $derived(
    blob.text === null
      ? formatBytes(blob.size)
      : `${plural(lineCount, "line")} · ${formatBytes(blob.size)}`,
  );
  let isImage = $derived(blob.contentType.startsWith("image/"));
</script>

<svelte:head><title>{blob.path} · {repo}</title></svelte:head>

<div class="grid gap-4">
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <BranchSelect
      branches={data.refs.branches.map((b) => b.name)}
      tags={data.refs.tags.map((t) => t.name)}
      value={data.ref}
      onchange={(r) => goto(links.blob(repo, r, blob.path))}
    />
    <Breadcrumbs items={pathCrumbs(repo, data.ref, blob.path)} />
  </div>

  <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line pb-2 text-meta">
    <span class="data text-muted">{sizeLine}</span>
    <span class="ml-auto flex gap-4">
      <a href={raw}>Raw</a>
      <a href={links.commits(repo, data.ref)}>History</a>
    </span>
  </div>

  {#if blob.text !== null}
    <CodeView text={blob.text} label={blob.path} />
  {:else if isImage}
    <div class="grid justify-items-start gap-2">
      <img src={raw} alt={blob.name} class="max-w-full border border-line-soft" />
    </div>
  {:else}
    <EmptyState title={blob.binary ? "Binary file not shown" : "File too large to show"}>
      <a href={raw}>View raw</a> ({formatBytes(blob.size)}).
    </EmptyState>
  {/if}
</div>
