<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { MenuItem } from "../types.js";

  /**
   * The signed-in account, top right: the handle in a pill, and a menu with
   * everything account-shaped (admin, public view, sign out). Signed out, a
   * plain "sign in" link takes its place (see SignInLink).
   */
  let { label, items }: { label: string; items: MenuItem[] } = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex max-w-48 items-center gap-1 rounded-control border border-line px-2 py-0.5 data text-fg sm:max-w-64"
  >
    <span class="truncate">{label}</span>
    <ChevronDown size={14} aria-hidden="true" class="shrink-0" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      align="end"
      sideOffset={4}
      class="z-50 min-w-44 border border-line bg-surface py-1 text-meta"
    >
      {#each items as item (item.label)}
        {#if item.href}
          <DropdownMenu.Item
            class="block px-3 py-1.5 no-underline outline-none data-highlighted:bg-sunken"
          >
            {#snippet child({ props })}
              <a {...props} href={item.href}>{item.label}</a>
            {/snippet}
          </DropdownMenu.Item>
        {:else}
          <DropdownMenu.Item
            onSelect={item.onSelect}
            class="block cursor-pointer px-3 py-1.5 outline-none data-highlighted:bg-sunken"
            >{item.label}</DropdownMenu.Item
          >
        {/if}
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
