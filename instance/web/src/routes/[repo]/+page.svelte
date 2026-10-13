<script lang="ts">
  import { CopyButton, EmptyState, Section } from "@mycelium/ui";
  import { invalidateAll } from "$app/navigation";
  import CodeTree from "$lib/CodeTree.svelte";
  import { debounce, onLive } from "$lib/live.svelte";

  let { data } = $props();

  let owner = $derived(data.status?.signedIn ?? false);

  // Live: a push to the branch shown here (or any, while empty) reloads it.
  const reload = debounce(() => invalidateAll());
  $effect(() => {
    const ref = data.ref;
    return onLive(data.repo.name, ["push"], (m) => {
      if (!m || m.type !== "push" || !ref || m.ref === `refs/heads/${ref}`) reload();
    });
  });
  let settings = $derived(`/${data.repo.name}/settings`);
  let pushCommands = $derived(
    `git remote add origin ${data.repo.remote}\n` +
      `git -c http.extraHeader="Authorization: Bearer $TOKEN" push -u origin ${data.repo.defaultBranch}`,
  );
</script>

{#snippet credentials()}
  {#if owner}
    Git needs a token: get one under <a href={settings}>Settings → Git credentials</a>, then use it
    as <code class="data">http.extraHeader="Authorization: Bearer &lt;token&gt;"</code>.
  {:else}
    Cloning needs a token from the repository's owner.
  {/if}
{/snippet}

<div class="grid gap-6">
  {#if data.repo.description}<p class="max-w-reading">{data.repo.description}</p>{/if}

  {#if !data.ref || !data.listing}
    <EmptyState title="This repository is empty">
      <div class="grid gap-2">
        <p>Push a branch to get started:</p>
        <pre class="data overflow-x-auto bg-sunken p-3 whitespace-pre">{pushCommands}</pre>
        <p>{@render credentials()}</p>
      </div>
    </EmptyState>
  {:else}
    <CodeTree
      repo={data.repo.name}
      refs={data.refs}
      ref={data.ref}
      listing={data.listing}
      readme={data.readme}
    />
    <Section title="Clone">
      <div class="grid gap-2">
        <div class="flex flex-wrap items-center gap-3">
          <code class="data min-w-0 break-all">{data.repo.remote}</code>
          <CopyButton value={data.repo.remote} />
        </div>
        <p class="max-w-reading text-meta text-muted">{@render credentials()}</p>
      </div>
    </Section>
  {/if}
</div>
