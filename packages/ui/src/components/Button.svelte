<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  /**
   * One button for every surface. "primary" is the one filled action on a
   * screen; "quiet" is a text-weight action inside rows and toolbars. With an
   * href it renders a link that looks like a button.
   */
  type Props = HTMLButtonAttributes & {
    variant?: "primary" | "default" | "quiet";
    size?: "sm" | "md";
    href?: string;
    children: Snippet;
  };
  let {
    variant = "default",
    size = "md",
    href,
    children,
    class: extra = "",
    ...rest
  }: Props = $props();

  const base =
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control no-underline disabled:cursor-not-allowed disabled:opacity-50";
  let classes = $derived(
    [
      base,
      size === "sm" ? "px-2 py-0.5 text-meta" : "px-3 py-1.5",
      variant === "primary"
        ? "border border-primary bg-primary text-primary-fg"
        : variant === "quiet"
          ? "border border-transparent underline underline-offset-2"
          : "border border-line bg-surface text-fg",
      extra,
    ].join(" "),
  );
</script>

{#if href}
  <a {href} class={classes}>{@render children()}</a>
{:else}
  <button type="button" {...rest} class={classes}>{@render children()}</button>
{/if}
