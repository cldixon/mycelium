<script lang="ts">
  import Radio from "@lucide/svelte/icons/radio";
  import WifiOff from "@lucide/svelte/icons/wifi-off";

  /**
   * Whether a page is following live updates: "Live" while its socket is
   * open, "Connecting" or "Offline (refreshing every few seconds)" otherwise.
   * Shape and words carry the state, not colour.
   */
  let { status }: { status: "connecting" | "live" | "offline" } = $props();

  const LABELS = {
    live: "Live",
    connecting: "Connecting…",
    offline: "Offline",
  } as const;
  const TITLES = {
    live: "Updates appear as they happen",
    connecting: "Connecting to live updates",
    offline: "Live updates are down; the page refreshes every few seconds",
  } as const;
</script>

<span
  class="inline-flex items-center gap-1 text-meta text-muted"
  role="status"
  title={TITLES[status]}
  data-live={status}
>
  {#if status === "offline"}
    <WifiOff size={14} aria-hidden="true" class="flex-none" />
  {:else}
    <Radio size={14} aria-hidden="true" class="flex-none" />
  {/if}
  {LABELS[status]}
</span>
