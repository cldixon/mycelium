<script lang="ts">
  import { goto } from "$app/navigation";
  import type { Readme as ReadmeData, RepoRefs, TreeListing } from "$shared/types";
  import {
    BranchSelect,
    Breadcrumbs,
    FileTable,
    Readme,
    Section,
    shortSha,
    timeAgo,
    type FileRow,
  } from "@mycelium/ui";
  import { dirname, links, pathCrumbs, rawUrl } from "$lib/code";

  /** A directory at a ref: branch select, breadcrumbs, latest commit, files, README. */
  let {
    repo,
    refs,
    ref,
    listing,
    readme,
  }: {
    repo: string;
    refs: RepoRefs;
    ref: string;
    listing: TreeListing;
    readme: ReadmeData | null;
  } = $props();

  let path = $derived(listing.path);
  let rows = $derived<FileRow[]>(
    listing.entries.map((e) => ({
      name: e.name,
      kind:
        e.type === "tree"
          ? "dir"
          : e.type === "gitlink"
            ? "submodule"
            : e.type === "symlink"
              ? "symlink"
              : "file",
      href:
        e.type === "tree"
          ? links.tree(repo, ref, e.path)
          : e.type === "gitlink"
            ? null
            : links.blob(repo, ref, e.path),
      meta: e.type === "gitlink" ? `@ ${shortSha(e.sha)}` : undefined,
    })),
  );

  const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;

  /** README-relative links: images load raw bytes, everything else opens the file page. */
  function resolve(target: string): string {
    const parts = (readme ? dirname(readme.path) : path).split("/").filter(Boolean);
    for (const p of target.split("/")) {
      if (p === "..") parts.pop();
      else if (p && p !== ".") parts.push(p);
    }
    const full = parts.join("/");
    return IMAGE.test(full) ? rawUrl(repo, ref, full) : links.blob(repo, ref, full);
  }
</script>

<div class="grid gap-4">
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <BranchSelect
      branches={refs.branches.map((b) => b.name)}
      tags={refs.tags.map((t) => t.name)}
      value={ref}
      onchange={(r) => goto(links.tree(repo, r, path))}
    />
    <Breadcrumbs items={pathCrumbs(repo, ref, path)} />
    <span class="ml-auto flex gap-4 text-meta">
      <a href="/{repo}/branches">{refs.branches.length} branches</a>
      <a href={links.commits(repo, ref)}>Commits</a>
    </span>
  </div>

  <p class="flex flex-wrap items-baseline gap-x-3 border-b border-line pb-2 text-meta">
    <span class="font-semibold">{listing.commit.author.name}</span>
    <a href={links.commit(repo, listing.commit.sha)} class="min-w-0 truncate">
      {listing.commit.title}
    </a>
    <span class="data ml-auto text-muted">
      <a href={links.commit(repo, listing.commit.sha)}>{shortSha(listing.commit.sha)}</a>
      · {timeAgo(listing.commit.committedAt)}
    </span>
  </p>

  <FileTable {rows} parent={path ? links.tree(repo, ref, dirname(path)) : null} />

  {#if readme}
    <Section title={readme.name}>
      {#if readme.markdown}
        <Readme markdown={readme.text} {resolve} />
      {:else}
        <pre class="data whitespace-pre-wrap">{readme.text}</pre>
      {/if}
    </Section>
  {/if}
</div>
