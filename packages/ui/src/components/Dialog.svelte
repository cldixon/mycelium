<script lang="ts">
  import type { Snippet } from "svelte";
  import { Dialog } from "bits-ui";

  /**
   * A modal for one focused task (mirror, confirm). Escape and the backdrop
   * close it; focus is trapped inside while it's open.
   */
  let {
    open = $bindable(false),
    onOpenChange,
    title,
    description,
    trigger,
    children,
    footer,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    title: string;
    description?: string;
    trigger?: Snippet<[Record<string, unknown>]>;
    children?: Snippet;
    footer?: Snippet;
  } = $props();
</script>

<Dialog.Root bind:open {onOpenChange}>
  {#if trigger}
    <Dialog.Trigger>
      {#snippet child({ props })}{@render trigger(props)}{/snippet}
    </Dialog.Trigger>
  {/if}
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-black/40" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 grid max-h-[90dvh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto border border-line bg-surface p-5"
    >
      <div class="grid gap-1">
        <Dialog.Title class="text-title font-semibold">{title}</Dialog.Title>
        {#if description}<Dialog.Description class="text-meta text-muted"
            >{description}</Dialog.Description
          >{/if}
      </div>
      {@render children?.()}
      {#if footer}<div class="flex flex-wrap justify-end gap-2">{@render footer()}</div>{/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
