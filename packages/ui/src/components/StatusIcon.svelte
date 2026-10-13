<script lang="ts">
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import CircleDashed from "@lucide/svelte/icons/circle-dashed";
  import CircleSlash from "@lucide/svelte/icons/circle-slash";
  import CircleMinus from "@lucide/svelte/icons/circle-minus";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";

  /**
   * The state of a job, check or step as an icon with a text label for
   * screen readers (and an optional visible one). Shape carries the meaning,
   * not colour: check, cross, alert, dashed (waiting), spinner (running).
   */
  type Status =
    "queued" | "pending" | "running" | "success" | "failure" | "error" | "cancelled" | "skipped";
  let {
    status,
    label = false,
    size = 16,
  }: { status: Status | string; label?: boolean; size?: number } = $props();

  const ICONS = {
    queued: CircleDashed,
    pending: CircleDashed,
    running: LoaderCircle,
    success: CircleCheck,
    failure: CircleX,
    error: CircleAlert,
    cancelled: CircleSlash,
    skipped: CircleMinus,
  } as const;
  let Icon = $derived(ICONS[status as Status] ?? CircleDashed);
</script>

<span class="inline-flex items-center gap-1.5 align-middle" title={status}>
  <Icon
    {size}
    aria-hidden="true"
    class="flex-none {status === 'running' ? 'animate-spin' : ''} {status === 'skipped' ||
    status === 'cancelled'
      ? 'text-muted'
      : ''}"
  />
  {#if label}<span>{status}</span>{:else}<span class="sr-only">{status}</span>{/if}
</span>
