<script lang="ts">
  import { onMount } from "svelte";
  import { Button, Field, Loading, Notice, Section } from "@mycelium/ui";
  import { actions } from "$lib/actions";
  import { checks } from "$lib/checks";
  import { repoAdmin } from "$lib/repos";

  /**
   * Required checks (owner): pick a base branch and the workflows that must
   * pass on a pull request's head before it merges into it. Workflows come
   * from the default branch's `.mycelium/workflows/`.
   */
  let { repo, defaultBranch }: { repo: string; defaultBranch: string } = $props();

  let branch = $state("");
  let branches = $state<string[]>([]);
  /** Workflow names on the default branch; null while loading. */
  let available = $state<string[] | null>(null);
  let selected = $state<string[]>([]);
  let saved = $state<string[]>([]);
  let loadError = $state<string | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let done = $state(false);

  onMount(async () => {
    branch = defaultBranch;
    const [refs, workflows] = await Promise.all([
      repoAdmin.refs(repo).catch(() => null),
      actions.workflows(repo).catch((e) => {
        loadError = e instanceof Error ? e.message : String(e);
        return null;
      }),
    ]);
    branches = refs?.branches.map((b) => b.name) ?? [];
    available = workflows?.workflows.map((w) => w.name) ?? [];
  });

  // Load what the picked branch requires.
  $effect(() => {
    const b = branch;
    if (!b) return;
    done = false;
    checks
      .required(repo, b)
      .then((r) => {
        if (branch !== b) return;
        selected = r.workflows;
        saved = r.workflows;
      })
      .catch((e) => (loadError = e instanceof Error ? e.message : String(e)));
  });

  // Required names that are no longer on the default branch stay listed so they can be unticked.
  let names = $derived([...new Set([...(available ?? []), ...saved])].sort());
  let dirty = $derived([...selected].sort().join("\n") !== [...saved].sort().join("\n"));

  async function save(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    saveError = null;
    done = false;
    try {
      const r = await checks.setRequired(repo, branch, selected);
      selected = r.workflows;
      saved = r.workflows;
      done = true;
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<Section
  title="Required checks"
  description="Workflows that must pass on a pull request's latest commit before it can merge into the branch."
>
  {#if available === null}
    <Loading label="Loading workflows…" />
  {:else}
    <form class="grid max-w-form gap-4" onsubmit={save}>
      <Field label="Branch" hint="Pull requests into this branch need the checks below.">
        <select class="input" bind:value={branch}>
          {#if !branches.includes(branch)}<option value={branch}>{branch}</option>{/if}
          {#each branches as b (b)}<option value={b}>{b}</option>{/each}
        </select>
      </Field>
      {#if names.length === 0}
        <p class="text-meta text-muted">
          No workflows on {defaultBranch}. Add files under <code>.mycelium/workflows/</code> first.
        </p>
      {:else}
        <fieldset class="grid gap-1">
          <legend class="text-meta">Required workflows</legend>
          {#each names as name (name)}
            <label class="check">
              <input type="checkbox" bind:group={selected} value={name} />
              <span
                >{name}{#if !available.includes(name)}
                  <span class="text-meta text-muted">not on {defaultBranch}</span>{/if}</span
              >
            </label>
          {/each}
        </fieldset>
      {/if}
      {#if loadError}<Notice tone="error">{loadError}</Notice>{/if}
      {#if saveError}<Notice tone="error">{saveError}</Notice>{/if}
      {#if done && !dirty}<Notice tone="success">Saved.</Notice>{/if}
      <div>
        <Button variant="primary" type="submit" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save required checks"}
        </Button>
      </div>
    </form>
  {/if}
</Section>
