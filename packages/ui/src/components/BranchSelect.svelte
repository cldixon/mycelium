<script lang="ts">
  import { Select } from "bits-ui";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Check from "@lucide/svelte/icons/check";

  /**
   * Pick a branch or tag. The page decides what picking means (usually a
   * navigation) through `onchange`. A ref that isn't a branch or tag (a commit
   * sha) is shown shortened in the trigger.
   */
  let {
    branches,
    tags = [],
    value,
    onchange,
    label = "Switch branch or tag",
  }: {
    branches: string[];
    tags?: string[];
    value: string;
    onchange: (ref: string) => void;
    label?: string;
  } = $props();

  let shown = $derived(/^[0-9a-f]{40}$/i.test(value) ? value.slice(0, 7) : value);
  const itemClass =
    "flex cursor-pointer items-center gap-2 px-3 py-1 data text-fg outline-none data-highlighted:bg-sunken";
</script>

<Select.Root type="single" {value} onValueChange={(v) => v && v !== value && onchange(v)}>
  <Select.Trigger
    aria-label={label}
    class="inline-flex max-w-64 items-center gap-1 rounded-control border border-line bg-surface px-2 py-0.5 data text-fg"
  >
    <span class="truncate">{shown}</span>
    <ChevronDown size={14} aria-hidden="true" class="shrink-0" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      sideOffset={4}
      align="start"
      class="z-50 max-h-80 min-w-48 overflow-y-auto border border-line bg-surface py-1"
    >
      <Select.Viewport>
        <Select.Group>
          <Select.GroupHeading class="eyebrow px-3 py-1">Branches</Select.GroupHeading>
          {#each branches as name (name)}
            <Select.Item value={name} label={name} class={itemClass}>
              {#snippet children({ selected })}
                <span class="w-3.5 shrink-0"
                  >{#if selected}<Check size={14} aria-hidden="true" />{/if}</span
                >
                <span class="truncate">{name}</span>
              {/snippet}
            </Select.Item>
          {/each}
        </Select.Group>
        {#if tags.length > 0}
          <Select.Group>
            <Select.GroupHeading class="eyebrow px-3 pt-2 pb-1">Tags</Select.GroupHeading>
            {#each tags as name (name)}
              <Select.Item value={name} label={name} class={itemClass}>
                {#snippet children({ selected })}
                  <span class="w-3.5 shrink-0"
                    >{#if selected}<Check size={14} aria-hidden="true" />{/if}</span
                  >
                  <span class="truncate">{name}</span>
                {/snippet}
              </Select.Item>
            {/each}
          </Select.Group>
        {/if}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>
