<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { goto, invalidateAll } from "$app/navigation";
  import type { GitCredentials, GitScope, Repo, Visibility } from "$shared/types";
  import { Button, CopyButton, Field, Notice, Section, formatDateTime } from "@mycelium/ui";
  import { gitCommands, repoAdmin } from "$lib/repos";
  import RequiredChecksSection from "./RequiredChecksSection.svelte";

  let { data } = $props();

  let owner = $derived(data.status?.signedIn ?? false);
  // Local copy of the repo, refreshed from each save.
  const initial = untrack(() => data.repo);
  let repo = $state<Repo>(initial);

  // --- General -------------------------------------------------------------
  let description = $state(initial.description ?? "");
  let visibility = $state<Visibility>(initial.visibility);
  let defaultBranch = $state(initial.defaultBranch);
  /** Branch names from /refs; null when unavailable (free text then). */
  let branches = $state<string[] | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let saved = $state(false);

  onMount(async () => {
    try {
      const refs = await repoAdmin.refs(initial.name);
      branches = refs.branches.map((b) => b.name);
    } catch {
      branches = null;
    }
  });

  let dirty = $derived(
    description.trim() !== (repo.description ?? "") ||
      visibility !== repo.visibility ||
      defaultBranch.trim() !== repo.defaultBranch,
  );

  async function save(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    saveError = null;
    saved = false;
    try {
      repo = await repoAdmin.update(repo.name, {
        description: description.trim() || null,
        visibility,
        defaultBranch: defaultBranch.trim(),
      });
      saved = true;
      await invalidateAll(); // the header shows visibility
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  // --- Clone and push ------------------------------------------------------
  let scope = $state<GitScope>("write");
  let creds = $state<GitCredentials | null>(null);
  let credsError = $state<string | null>(null);
  let minting = $state(false);
  let commands = $derived(creds ? gitCommands(creds, repo.name, repo.defaultBranch) : null);

  async function mint() {
    minting = true;
    credsError = null;
    try {
      creds = await repoAdmin.gitCredentials(repo.name, scope);
    } catch (e) {
      credsError = e instanceof Error ? e.message : String(e);
    } finally {
      minting = false;
    }
  }

  // --- Danger zone ---------------------------------------------------------
  let confirmName = $state("");
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  async function remove(event: SubmitEvent) {
    event.preventDefault();
    if (confirmName !== repo.name) return;
    deleting = true;
    deleteError = null;
    try {
      await repoAdmin.remove(repo.name);
      await goto("/");
    } catch (e) {
      deleteError = e instanceof Error ? e.message : String(e);
      deleting = false;
    }
  }
</script>

{#if !owner}
  <Notice title="Owner only">Sign in as the instance owner to change this repository.</Notice>
{:else}
  <div class="grid max-w-reading gap-10">
    <Section title="General">
      <form class="grid max-w-form gap-4" onsubmit={save}>
        <Field label="Description">
          <input class="input" bind:value={description} maxlength="350" />
        </Field>
        <fieldset class="grid gap-1">
          <legend class="text-meta">Visibility</legend>
          <label class="check">
            <input type="radio" bind:group={visibility} value="private" />
            <span>Private <span class="text-meta text-muted">only you can see it</span></span>
          </label>
          <label class="check">
            <input type="radio" bind:group={visibility} value="public" />
            <span>Public <span class="text-meta text-muted">anyone can read it</span></span>
          </label>
        </fieldset>
        <Field
          label="Default branch"
          hint="The branch the Code tab shows and pull requests target by default."
        >
          {#if branches && branches.length > 0}
            <select class="input" bind:value={defaultBranch}>
              {#if !branches.includes(defaultBranch)}
                <option value={defaultBranch}>{defaultBranch}</option>
              {/if}
              {#each branches as b (b)}<option value={b}>{b}</option>{/each}
            </select>
          {:else}
            <input class="input" bind:value={defaultBranch} spellcheck="false" />
          {/if}
        </Field>
        {#if saveError}<Notice tone="error">{saveError}</Notice>{/if}
        {#if saved && !dirty}<Notice tone="success">Saved.</Notice>{/if}
        <div>
          <Button variant="primary" type="submit" disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Section>

    <Section
      title="Clone and push"
      description="Get a short-lived token (one hour) for plain git. It goes in a header, not the URL."
    >
      <div class="flex flex-wrap items-center gap-4">
        <label class="check">
          <input type="radio" bind:group={scope} value="write" />
          <span>Read and write</span>
        </label>
        <label class="check">
          <input type="radio" bind:group={scope} value="read" />
          <span>Read only</span>
        </label>
        <Button onclick={mint} disabled={minting}>
          {minting ? "Requesting…" : creds ? "New token" : "Get git credentials"}
        </Button>
      </div>
      {#if credsError}<Notice tone="error">{credsError}</Notice>{/if}
      {#if creds && commands}
        <dl class="grid gap-3 text-meta">
          <div class="grid gap-1">
            <dt class="flex gap-3">Remote <CopyButton value={creds.remote} /></dt>
            <dd class="data break-all">{creds.remote}</dd>
          </div>
          <div class="grid gap-1">
            <dt class="flex gap-3">Clone <CopyButton value={commands.clone} /></dt>
            <dd><pre class="data overflow-x-auto bg-sunken p-3">{commands.clone}</pre></dd>
          </div>
          {#if creds.scope === "write"}
            <div class="grid gap-1">
              <dt class="flex gap-3">
                Push an existing repository <CopyButton value={commands.push} />
              </dt>
              <dd><pre class="data overflow-x-auto bg-sunken p-3">{commands.push}</pre></dd>
            </div>
          {/if}
          <p class="text-muted">
            {creds.scope === "write" ? "Read and write" : "Read-only"} token, expires {formatDateTime(
              creds.expiresAt,
            )}. The <code>https://x:TOKEN@…</code> URL form doesn't work with these tokens.
          </p>
        </dl>
      {/if}
    </Section>

    <RequiredChecksSection repo={repo.name} defaultBranch={repo.defaultBranch} />

    <Section title="Danger zone">
      <form class="grid max-w-form gap-3 border border-danger p-4" onsubmit={remove}>
        <p class="font-semibold">Delete this repository</p>
        <p class="text-meta">
          Deletes the git repository, its pull requests, workflow runs and push history. This can't
          be undone.
        </p>
        <Field label="Type {repo.name} to confirm">
          <input class="input" bind:value={confirmName} autocomplete="off" spellcheck="false" />
        </Field>
        {#if deleteError}<Notice tone="error">{deleteError}</Notice>{/if}
        <div>
          <Button type="submit" disabled={deleting || confirmName !== repo.name}>
            {deleting ? "Deleting…" : "Delete repository"}
          </Button>
        </div>
      </form>
    </Section>
  </div>
{/if}
