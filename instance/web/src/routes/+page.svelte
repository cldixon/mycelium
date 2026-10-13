<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { lastActivity, repoNameError, type Repo, type Visibility } from "$shared/types";
  import {
    Button,
    Dialog,
    EmptyState,
    Field,
    Loading,
    Notice,
    PageHeader,
    timeAgo,
  } from "@mycelium/ui";
  import { repos } from "$lib/api";
  import { repoAdmin } from "$lib/repos";
  import { debounce, INSTANCE, onLive } from "$lib/live.svelte";

  let { data } = $props();

  let owner = $derived(data.status?.signedIn ?? false);
  let list = $state<Repo[] | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    try {
      list = await repos.list();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(load);
  // Live: pushes and repo changes anywhere reload the list.
  $effect(() => onLive(INSTANCE, ["push", "repo"], debounce(load)));

  /** "2h ago", "now", or a date past a year. */
  const ago = (iso: string) => {
    const t = timeAgo(iso);
    return /^\d+[mhdw]$/.test(t) ? `${t} ago` : t;
  };

  // New repository dialog
  let open = $state(false);
  let name = $state("");
  let description = $state("");
  let visibility = $state<Visibility>("private");
  let importing = $state(false);
  let importUrl = $state("");
  let branch = $state("");
  let busy = $state(false);
  let formError = $state<string | null>(null);
  let touched = $state(false);
  let nameError = $derived(touched ? repoNameError(name.trim()) : null);

  function reset() {
    name = description = importUrl = branch = "";
    visibility = "private";
    importing = false;
    formError = null;
    touched = false;
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    touched = true;
    if (repoNameError(name.trim())) return;
    busy = true;
    formError = null;
    try {
      const repo = await repoAdmin.create({
        name: name.trim(),
        description: description.trim() || null,
        visibility,
        ...(importing && { importUrl: importUrl.trim(), branch: branch.trim() || null }),
      });
      open = false;
      reset();
      await goto(`/${encodeURIComponent(repo.name)}`);
    } catch (e) {
      formError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid gap-6">
  <PageHeader title="Repositories">
    {#snippet actions()}
      {#if owner}
        <Dialog
          bind:open
          onOpenChange={(o) => !o && reset()}
          title="New repository"
          description="Create an empty repository, or import one from a public git URL."
        >
          {#snippet trigger(props)}
            <Button variant="primary" {...props}>New repository</Button>
          {/snippet}
          <form id="new-repo" class="grid gap-4" onsubmit={create}>
            <Field label="Name" error={nameError}>
              <input
                class="input"
                bind:value={name}
                onblur={() => (touched = true)}
                required
                autocomplete="off"
                spellcheck="false"
                maxlength="100"
              />
            </Field>
            <Field label="Description (optional)">
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
            <label class="check">
              <input type="checkbox" bind:checked={importing} />
              <span>Import from a public git URL</span>
            </label>
            {#if importing}
              <Field label="Git URL" hint="An https:// URL that needs no sign-in.">
                <input
                  class="input"
                  type="url"
                  bind:value={importUrl}
                  required
                  placeholder="https://github.com/owner/repo.git"
                />
              </Field>
              <Field label="Branch (optional)" hint="Defaults to the source's default branch.">
                <input class="input" bind:value={branch} spellcheck="false" />
              </Field>
            {/if}
            {#if formError}<Notice tone="error">{formError}</Notice>{/if}
          </form>
          {#snippet footer()}
            <Button onclick={() => (open = false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="new-repo" disabled={busy}>
              {busy ? (importing ? "Importing…" : "Creating…") : importing ? "Import" : "Create"}
            </Button>
          {/snippet}
        </Dialog>
      {/if}
    {/snippet}
  </PageHeader>

  {#if error}
    <Notice tone="error" title="Couldn't load repositories">{error}</Notice>
  {:else if list === null}
    <Loading />
  {:else if list.length === 0}
    <EmptyState title="No repositories yet">
      {#if owner}
        Create an empty repository or import one from a public git URL.
      {:else}
        Nothing public here. <a href="/signin">Sign in</a> if this is your instance.
      {/if}
      {#snippet action()}
        {#if owner}<Button onclick={() => (open = true)}>New repository</Button>{/if}
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="grid">
      {#each list as repo (repo.name)}
        <li class="grid gap-1 border-b border-line-soft py-3">
          <div class="flex flex-wrap items-baseline gap-x-3">
            <a href="/{encodeURIComponent(repo.name)}" class="font-semibold">{repo.name}</a>
            <span class="eyebrow">{repo.visibility}</span>
            <span class="data ml-auto text-muted">Updated {ago(lastActivity(repo))}</span>
          </div>
          {#if repo.description}<p class="text-meta text-muted">{repo.description}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
