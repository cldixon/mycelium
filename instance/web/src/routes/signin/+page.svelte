<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Notice, SignInForm, shortDid } from "@mycelium/ui";
  import { auth } from "$lib/api";

  let { data } = $props();

  const ERRORS: Record<string, string> = {
    sign_in_failed: "Sign-in didn't complete. Try again.",
    not_owner: "That account doesn't own this instance.",
    unclaimed: "This instance hasn't been claimed yet. Sign in with the setup code.",
  };

  let status = $derived(data.status);
  let error = $state<string | null>(null);
  let handle = $state("");
  let setupCode = $state("");
  let signingIn = $state(false);

  onMount(() => {
    const reason = page.url.searchParams.get("error");
    if (reason) error = ERRORS[reason] ?? "Sign-in failed.";
    if (status?.signedIn) void goto("/");
  });

  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    signingIn = true;
    error = null;
    try {
      const { url } = await auth.login(handle, status?.claimed ? undefined : setupCode);
      location.href = url;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      signingIn = false;
    }
  }
</script>

<svelte:head><title>Sign in · {status?.title ?? "mycelium"}</title></svelte:head>

{#if !status}
  <Notice tone="error" title="Couldn't reach this instance's API">Reload to try again.</Notice>
{:else}
  <div class="grid max-w-form gap-4">
    {#if !status.claimed}
      <h1 class="text-page font-semibold">Claim this instance</h1>
      <p>
        This instance has no owner yet. Sign in with your AT Protocol account and the setup code
        from deploying it; that account becomes its owner.
      </p>
    {:else}
      <h1 class="text-page font-semibold">Sign in</h1>
    {/if}
    <SignInForm bind:handle onsubmit={signIn} {error} busy={signingIn}>
      {#snippet fields()}
        {#if !status.claimed}
          <label class="grid gap-1">
            <span class="text-meta">Setup code</span>
            <input class="input data" bind:value={setupCode} autocomplete="off" required />
            <span class="text-meta text-muted"
              >The <code class="data">SETUP_CODE</code> secret, or the code in the Worker's logs.</span
            >
          </label>
        {/if}
      {/snippet}
      {#snippet note()}
        {#if status.claimed}
          Owner: <code class="data">{status.owner ? shortDid(status.owner) : "-"}</code>. Only this
          account can sign in. Everyone else: <a href="/">browse public repositories</a>.
        {:else}
          You'll be redirected to your PDS to authorize. No email, no password. The setup code works
          once; after that this page is a normal sign-in.
        {/if}
      {/snippet}
    </SignInForm>
  </div>
{/if}
