<script lang="ts">
  import type { CommitFileDiff } from "$shared/types";
  import {
    DiffView,
    MetaList,
    Notice,
    PageHeader,
    formatDateTime,
    plural,
    shortSha,
  } from "@mycelium/ui";
  import { links } from "$lib/code";

  let { data } = $props();

  let repo = $derived(data.repo.name);
  let d = $derived(data.detail);
  let c = $derived(d.commit);
  let body = $derived(c.message.split("\n").slice(1).join("\n").trim());

  function note(f: CommitFileDiff): string {
    if (f.binary) return "Binary file not shown.";
    if (f.tooLarge) return "Diff too large to show.";
    if (f.oldMode !== f.newMode && f.oldMode && f.newMode) {
      return `File mode changed from ${f.oldMode} to ${f.newMode}.`;
    }
    return f.status === "added" || f.status === "deleted" ? "Empty file." : "No content changes.";
  }
</script>

<svelte:head><title>{c.title} · {shortSha(c.sha)} · {repo}</title></svelte:head>

<div class="grid gap-6">
  <PageHeader title={c.title}>
    {#snippet meta()}
      {c.author.name} authored {formatDateTime(c.authoredAt)}
      {#if c.committer.email !== c.author.email}
        · {c.committer.name} committed{/if}
    {/snippet}
    {#snippet actions()}
      <a href={links.tree(repo, c.sha)} class="text-meta">Browse files at this commit</a>
    {/snippet}
  </PageHeader>

  {#if body}<pre class="data max-w-reading whitespace-pre-wrap">{body}</pre>{/if}

  <MetaList
    rows={[
      { label: "Commit", value: c.sha, mono: true },
      ...c.parents.map((p, i) => ({
        label: i === 0 ? "Parent" : `Parent ${i + 1}`,
        value: p,
        href: links.commit(repo, p),
        mono: true,
      })),
    ]}
  />

  <p class="text-meta">
    Showing {plural(d.totalFiles, "changed file")} with {plural(d.additions, "addition")} and
    {plural(d.deletions, "deletion")}{#if d.parent}{" "}against the first parent{/if}.
  </p>
  {#if d.truncated}
    <Notice title="Large commit">
      Only the first {d.files.length} of {d.totalFiles} files are shown.
    </Notice>
  {/if}

  <ul class="grid gap-1 text-meta">
    {#each d.files as f, i (f.path)}
      <li class="flex gap-3">
        <span class="eyebrow w-16 shrink-0">{f.status}</span>
        <a href="#file-{i}" class="data min-w-0 break-all">{f.path}</a>
        <span class="data ml-auto text-muted">+{f.additions} −{f.deletions}</span>
      </li>
    {/each}
  </ul>

  <div class="grid gap-4">
    {#each d.files as f, i (f.path)}
      <DiffView
        id="file-{i}"
        path={f.path}
        status={f.status}
        additions={f.additions}
        deletions={f.deletions}
        hunks={f.hunks}
        note={note(f)}
      >
        {#snippet actions()}
          {#if f.status !== "deleted"}
            <a href={links.blob(repo, c.sha, f.path)}>View file</a>
          {/if}
        {/snippet}
      </DiffView>
    {/each}
  </div>
</div>
