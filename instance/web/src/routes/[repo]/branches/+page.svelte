<script lang="ts">
  import { EmptyState, Section, shortSha, timeAgo } from "@mycelium/ui";
  import { links } from "$lib/code";

  let { data } = $props();

  let repo = $derived(data.repo.name);
  /** The default branch first, then the most recently updated. */
  let branches = $derived(
    [...data.refs.branches].sort((a, b) => {
      if (a.name === data.refs.defaultBranch) return -1;
      if (b.name === data.refs.defaultBranch) return 1;
      return (b.commit?.committedAt ?? "").localeCompare(a.commit?.committedAt ?? "");
    }),
  );
</script>

<svelte:head><title>Branches · {repo}</title></svelte:head>

<div class="grid gap-8">
  <Section title="Branches">
    {#if branches.length === 0}
      <EmptyState title="No branches yet">Push a branch and it shows up here.</EmptyState>
    {:else}
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Branch</th>
              <th scope="col">Latest commit</th>
              <th scope="col">Updated</th>
              <th scope="col"><span class="sr-only">Links</span></th>
            </tr>
          </thead>
          <tbody>
            {#each branches as b (b.name)}
              <tr>
                <td class="data">
                  <a href={links.tree(repo, b.name)}>{b.name}</a>
                  {#if b.name === data.refs.defaultBranch}<span class="eyebrow ml-2">default</span
                    >{/if}
                </td>
                <td>
                  {#if b.commit}
                    <a href={links.commit(repo, b.sha)}>{b.commit.title}</a>
                    <span class="text-muted">· {b.commit.author.name}</span>
                  {:else}
                    <span class="data">{shortSha(b.sha)}</span>
                  {/if}
                </td>
                <td class="nowrap text-muted">
                  {b.commit ? timeAgo(b.commit.committedAt) : "-"}
                </td>
                <td class="nowrap"><a href={links.commits(repo, b.name)}>commits</a></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Section>

  {#if data.refs.tags.length > 0}
    <Section title="Tags">
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr><th scope="col">Tag</th><th scope="col">Commit</th></tr>
          </thead>
          <tbody>
            {#each data.refs.tags as t (t.name)}
              <tr>
                <td class="data"><a href={links.tree(repo, t.name)}>{t.name}</a></td>
                <td class="data"><a href={links.commit(repo, t.sha)}>{shortSha(t.sha)}</a></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Section>
  {/if}
</div>
