/** Formatting shared by every Mycelium surface, server and browser alike. */

/** Bytes as a short size, AutoIndex style: 812M, 4.1K, 2.1G. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes}B`;
  const units = ["K", "M", "G", "T", "P"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`;
}

/** A sha256 shortened for display: 9f2c3a… */
export function shortHash(sha256: string, length = 6): string {
  return sha256.length > length ? `${sha256.slice(0, length)}…` : sha256;
}

/** An ISO timestamp as a date: 2026-10-02. */
export function formatDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "-";
}

/** An ISO timestamp as date and minute: 2026-10-02 14:11. */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "-";
}

/** How long ago, compactly: 2h, 5d, 3w. Past a year, the date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 365) return `${Math.round(days / 7)}w`;
  return formatDate(iso);
}

/** "3 files", "1 file". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** The host of a URL, or the input if it isn't one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A DID shortened for display: did:plc:7k3bqz…9x */
export function shortDid(did: string): string {
  const [scheme, method, id] = did.split(":");
  if (!id || id.length <= 10) return did;
  return `${scheme}:${method}:${id.slice(0, 6)}…${id.slice(-2)}`;
}

/** A git sha shortened for display: 9f2c3a1. */
export function shortSha(sha: string, length = 7): string {
  return sha.slice(0, length);
}
