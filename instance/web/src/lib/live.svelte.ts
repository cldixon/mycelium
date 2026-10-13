import type { LiveEventType, LiveMessage } from "$shared/live";

/**
 * Live updates (issue #18): one WebSocket per scope, a repo or the whole
 * instance ("*"), shared by every component that listens. It reconnects with
 * backoff; after a gap, listeners are called with `null` (events may have
 * been missed: reload). `status` is reactive, for the Live indicator and for
 * pages that poll while the socket is down.
 */

export type LiveStatus = "connecting" | "live" | "offline";
/** A message, or null after a reconnect (reload what you show). */
export type LiveListener = (message: LiveMessage | null) => void;

/** The scope of the instance-wide feed. */
export const INSTANCE = "*";

const PING_MS = 30_000;
const IDLE_CLOSE_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** The server's "reconnect and be authorized again" close code. */
const REAUTHORIZE = 4001;

type Sub = { types: Set<LiveEventType> | null; fn: LiveListener };

class LiveFeed {
  status = $state<LiveStatus>("connecting");
  private socket: WebSocket | null = null;
  private subs = new Set<Sub>();
  private retry = 0;
  private connectedOnce = false;
  private ping: ReturnType<typeof setInterval> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly scope: string) {}

  /** Listen for `types` (all when empty). Returns the unsubscribe function. */
  subscribe(types: LiveEventType[], fn: LiveListener): () => void {
    const sub: Sub = { types: types.length ? new Set(types) : null, fn };
    this.subs.add(sub);
    clearTimeout(this.idle);
    if (!this.socket && this.timer === undefined) this.connect();
    return () => {
      this.subs.delete(sub);
      // Moving between pages of one repo keeps the socket.
      if (this.subs.size === 0) this.idle = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    };
  }

  private url(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const path =
      this.scope === INSTANCE ? "/api/live" : `/api/repos/${encodeURIComponent(this.scope)}/live`;
    return `${proto}//${location.host}${path}`;
  }

  private connect() {
    this.timer = undefined;
    if (typeof WebSocket === "undefined") return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.status = "offline";
      return this.later();
    }
    this.socket = ws;
    this.status = this.status === "live" ? "connecting" : this.status;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data === "pong") return;
      let message: (LiveMessage | { type: "hello" }) | null = null;
      try {
        message = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!message) return;
      if (message.type === "hello") {
        this.status = "live";
        this.retry = 0;
        // After a gap, events may have been missed: everyone reloads.
        if (this.connectedOnce) this.emit(null);
        this.connectedOnce = true;
        return;
      }
      this.emit(message as LiveMessage);
    };
    ws.onclose = (e) => {
      if (this.socket !== ws) return;
      this.socket = null;
      clearInterval(this.ping);
      if (this.subs.size === 0) return;
      this.status = "offline";
      if (e.code === REAUTHORIZE) this.retry = 0;
      this.later();
    };
    ws.onerror = () => ws.close();
    clearInterval(this.ping);
    this.ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, PING_MS);
  }

  private later() {
    const ms = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.retry) * (0.75 + Math.random() / 2);
    this.retry++;
    this.timer = setTimeout(() => this.connect(), ms);
  }

  private emit(message: LiveMessage | null) {
    for (const sub of [...this.subs]) {
      if (message && sub.types && !sub.types.has(message.type)) continue;
      try {
        sub.fn(message);
      } catch (error) {
        console.error("live listener failed", error);
      }
    }
  }

  private close() {
    clearInterval(this.ping);
    clearTimeout(this.timer);
    this.timer = undefined;
    const ws = this.socket;
    this.socket = null;
    this.connectedOnce = false;
    this.retry = 0;
    this.status = "connecting";
    ws?.close(1000, "idle");
  }
}

const feeds = new Map<string, LiveFeed>();

/** The shared feed of a repo, or of the instance (`INSTANCE`). */
export function liveFeed(scope: string): LiveFeed {
  let feed = feeds.get(scope);
  if (!feed) feeds.set(scope, (feed = new LiveFeed(scope)));
  return feed;
}

/**
 * Listen inside a component: `$effect(() => onLive(repo, ["push"], fn))`.
 * Returns the unsubscribe function, which $effect calls on teardown.
 */
export function onLive(scope: string, types: LiveEventType[], fn: LiveListener): () => void {
  return liveFeed(scope).subscribe(types, fn);
}

/** Calls `fn` at most once per `ms`, at the end (bursts of events → one reload). */
export function debounce(fn: () => unknown, ms = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
