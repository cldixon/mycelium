<script lang="ts">
  import { EmptyState, Section, formatDate, plural } from "@mycelium/ui";
  import { links } from "$lib/code";

  let { data } = $props();

  let repo = $derived(data.repo.name);
  let list = $derived(data.list);
</script>

<svelte:head><title>Contributors · {repo}</title></svelte:head>

<Section
  title="Contributors"
  description="Commit authors on {list.ref}, from the {list.truncated
    ? `latest ${list.scanned}`
    : plural(list.scanned, 'commit')}."
>
  {#if list.contributors.length === 0}
    <EmptyState title="No contributors yet">
      Nothing has been committed to <span class="data">{list.ref}</span>.
    </EmptyState>
  {:else}
    <div class="table-scroll">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col" class="num">Commits</th>
            <th scope="col">First</th>
            <th scope="col">Latest</th>
            <th scope="col">Agents</th>
          </tr>
        </thead>
        <tbody>
          {#each list.contributors as c (c.email + c.name)}
            <tr>
              <td class="font-semibold">{c.name}</td>
              <td class="data break-all text-muted">{c.email}</td>
              <td class="num data">{c.commits}</td>
              <td class="data nowrap">{formatDate(c.firstAt)}</td>
              <td class="data nowrap">{formatDate(c.lastAt)}</td>
              <td class="data">{c.agents.join(", ") || "-"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="text-meta">
      <a href={links.commits(repo, list.ref)}>View the commit history</a>
    </p>
  {/if}
</Section>
