<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { goto, invalidate } from "$app/navigation";
  import { AccountMenu, NavLink, Shell, personName, type MenuItem } from "@mycelium/ui";
  import { auth } from "$lib/api";

  let { data, children } = $props();

  let title = $derived(data.status?.title || "mycelium");
  let signedIn = $derived(data.status?.signedIn ?? false);
  let handle = $derived(
    data.status?.owner
      ? personName(data.status.owner, { did: data.status.owner, handle: data.status.handle })
      : "owner",
  );

  async function signOut() {
    await auth.logout().catch(() => {});
    await invalidate("mycelium:session");
    await goto("/");
  }

  let menu = $derived<MenuItem[]>([
    { label: "Repositories", href: "/" },
    { label: "Settings", href: "/settings" },
    { label: "Sign out", onSelect: signOut },
  ]);
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<Shell>
  {#snippet brand()}
    <a href="/" class="no-underline">{title}</a>
  {/snippet}
  {#snippet nav()}
    {#if signedIn}
      <NavLink href="/" current={page.url.pathname === "/"}>repositories</NavLink>
    {/if}
    <NavLink href="/activity" current={page.url.pathname === "/activity"}>activity</NavLink>
  {/snippet}
  {#snippet account()}
    {#if signedIn}
      <AccountMenu label={handle} items={menu} />
    {:else if page.url.pathname !== "/signin"}
      <a href="/signin" class="text-meta text-muted">sign in</a>
    {/if}
  {/snippet}
  {@render children()}
</Shell>
