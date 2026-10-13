<script lang="ts">
  import type { CommitInfo } from "$shared/types";
  import { timeAgo } from "@mycelium/ui";

  /** Head's commits in a pull request, oldest first. Links to the Code feature's commit page. */
  let { repo, commits }: { repo: string; commits: CommitInfo[] } = $props();

  const subject = (message: string) => message.split("\n", 1)[0] ?? "";
</script>

<ul class="grid">
  {#each commits as commit (commit.sha)}
    <li class="flex flex-wrap items-baseline gap-x-3 border-b border-line-soft py-2">
      <a href="/{repo}/commit/{commit.sha}">{subject(commit.message)}</a>
      <span class="text-meta text-muted">{commit.author.name}</span>
      <span class="data ml-auto text-muted">
        {commit.sha.slice(0, 7)} · {timeAgo(commit.author.date)}
      </span>
    </li>
  {/each}
</ul>
