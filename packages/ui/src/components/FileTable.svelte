<script module lang="ts">
  /** One row of a FileTable. */
  export type FileRow = {
    name: string;
    kind: "dir" | "file" | "symlink" | "submodule";
    /** Null for entries that can't be opened (submodules). */
    href?: string | null;
    /** Right-hand detail, e.g. a size or a short sha. */
    meta?: string;
  };
</script>

<script lang="ts">
  import Folder from "@lucide/svelte/icons/folder";
  import FileIcon from "@lucide/svelte/icons/file";
  import FileSymlink from "@lucide/svelte/icons/file-symlink";
  import FolderGit from "@lucide/svelte/icons/folder-git";
  import CornerLeftUp from "@lucide/svelte/icons/corner-left-up";

  /**
   * A directory listing: folders first (the caller sorts), one row per entry,
   * with an optional ".." row to go up. Submodules have no link.
   */
  let {
    rows,
    parent,
    label = "Files",
  }: { rows: FileRow[]; parent?: string | null; label?: string } = $props();

  const ICONS = { dir: Folder, file: FileIcon, symlink: FileSymlink, submodule: FolderGit };
  const KIND = { dir: "Directory", file: "File", symlink: "Symlink", submodule: "Submodule" };
</script>

<div class="table-scroll">
  <table class="table data-table">
    <caption class="sr-only">{label}</caption>
    <thead class="sr-only">
      <tr><th scope="col">Name</th><th scope="col">Details</th></tr>
    </thead>
    <tbody>
      {#if parent}
        <tr>
          <td colspan="2">
            <a href={parent} class="inline-flex items-center gap-2 no-underline hover:underline">
              <CornerLeftUp size={14} aria-hidden="true" /><span>..</span>
            </a>
          </td>
        </tr>
      {/if}
      {#each rows as row (row.name)}
        {@const Icon = ICONS[row.kind]}
        <tr>
          <td>
            <span class="inline-flex items-center gap-2">
              <Icon size={14} aria-label={KIND[row.kind]} class="shrink-0 text-muted" />
              {#if row.href}
                <a href={row.href} class="no-underline hover:underline">{row.name}</a>
              {:else}
                <span>{row.name}</span>
              {/if}
            </span>
          </td>
          <td class="text-right text-muted">{row.meta ?? ""}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
