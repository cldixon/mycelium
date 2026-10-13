# @mycelium/ui

Mycelium's design system: one set of tokens, base styles and Svelte components for every Mycelium surface. Derived from igloo's `@igloo/ui`.

Stack: Svelte 5, Tailwind v4, [Bits UI](https://bits-ui.com) for interactive primitives (dropdown menu, dialog), [Lucide](https://lucide.dev) icons (`@lucide/svelte/icons/<name>`).

## Using it

```css
/* src/app.css */
@import "tailwindcss";
@import "@mycelium/ui/mycelium.css";
```

```svelte
<script lang="ts">
  import { Shell, RepoHeader, EmptyState } from "@mycelium/ui";
</script>
```

Add `@tailwindcss/vite` to the app's Vite plugins. `mycelium.css` also tells Tailwind to scan the components, so their classes are generated.

Plain TypeScript (no Svelte) can import `@mycelium/ui/format` and `@mycelium/ui/types`.

## Tokens (`src/mycelium.css`)

Every color, font, radius and width is a CSS variable, with light and dark values. Tailwind utilities read them: `bg-bg`, `bg-sunken`, `text-fg`, `text-muted`, `border-line`, `border-line-soft`, `bg-primary text-primary-fg`, `text-live`, `font-mono`, `rounded-control`, `max-w-reading`.

| Group  | Tokens                                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Color  | `--bg --surface --sunken --fg --muted --line --line-soft --primary --primary-fg --focus --live --dark --danger`                   |
| Type   | `--font-body --font-display --font-code`, and the scale `text-label text-data text-meta text-body text-title text-page text-hero` |
| Shape  | `--radius-control --radius-panel` (both 0)                                                                                        |
| Widths | `--width-page --width-reading --width-form`                                                                                       |

Pass 1 is structure only: black on white, system fonts, hairlines, plain underlined links, no accent. The visual direction changes these values, not the components or pages.

Shared classes: `.eyebrow` (small uppercase mono label), `.data` (paths, shas, sizes, times), `.input`, `.check`, `table.table` with `.num` and `.nowrap` cells inside `.table-scroll`, and `.prose` for READMEs.

## Components

| Component                                 | What it is                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `Shell`                                   | The page frame: top bar (brand, nav, account), main, footer                    |
| `Brand`, `NavLink`, `AccountMenu`         | Top bar parts. The account menu is the signed-in handle with a dropdown        |
| `PageHeader`, `Section`, `Breadcrumbs`    | Page and section headings, with meta lines and an actions column               |
| `RepoHeader`                              | `handle / repo`, visibility, and the repo tabs (Settings only for the owner)   |
| `TabNav`                                  | Page tabs as links                                                             |
| `MetaList`                                | Key/value facts as a table                                                     |
| `SignInForm`                              | AT Protocol sign-in: a handle and "Continue with AT Protocol"                  |
| `Button`, `Field`, `CopyButton`, `Dialog` | Controls                                                                       |
| `SortHeader`                              | A sortable table column header                                                 |
| `Notice`, `EmptyState`, `Loading`         | Messages and states                                                            |
| `Readme`                                  | Markdown rendered with `renderMarkdown` (escapes raw HTML, drops unsafe links) |

## Rules

- Repo content (READMEs, commit messages, PR bodies) is untrusted. Render it as text, or through `renderMarkdown`.
- Monospace and tabular numbers for anything from git: paths, shas, sizes, times.
