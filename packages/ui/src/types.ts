/** The shapes shared components render. */

export type MenuItem = {
  label: string;
  href?: string;
  onSelect?: () => void;
};

export type Crumb = { label: string; href?: string | null };

export type TabItem = {
  id: string;
  label: string;
  href: string;
  count?: number;
  /** Shown but not usable yet (reserved for later phases). */
  disabled?: boolean;
};

/** The tabs of a repo page, in RepoHeader. */
export type RepoTab = "code" | "pulls" | "actions" | "contributors" | "settings";
