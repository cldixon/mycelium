<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";
  import Notice from "./Notice.svelte";

  /**
   * AT Protocol sign-in, the same everywhere: one handle field and "Continue
   * with AT Protocol". No email, no password. With `action` it posts a plain
   * form (works without JavaScript); with `onsubmit` the page handles it.
   */
  let {
    action,
    onsubmit,
    handle = $bindable(""),
    error = null,
    busy = false,
    fields,
    note,
  }: {
    action?: string;
    onsubmit?: (event: SubmitEvent) => void;
    handle?: string;
    error?: string | null;
    busy?: boolean;
    /** Extra fields under the handle (the setup code on a first claim). */
    fields?: Snippet;
    note?: Snippet;
  } = $props();
</script>

<form method="post" {action} {onsubmit} class="grid max-w-form gap-4">
  <label class="grid gap-1">
    <span class="text-meta">Handle</span>
    <input
      class="input"
      name="handle"
      bind:value={handle}
      placeholder="you.bsky.social"
      autocomplete="username"
      autocapitalize="none"
      spellcheck="false"
      required
    />
  </label>
  {@render fields?.()}
  {#if error}<Notice tone="error">{error}</Notice>{/if}
  <div>
    <Button type="submit" variant="primary" disabled={busy}
      >{busy ? "Redirecting…" : "Continue with AT Protocol"}</Button
    >
  </div>
  {#if note}<div class="text-meta text-muted">{@render note()}</div>{/if}
</form>
