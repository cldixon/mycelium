import type { LiveMessage } from "../shared/live.js";

/**
 * Which sockets get a message. Free of Worker APIs so it can be tested; the
 * hub (src/live/hub.ts) hands it its hibernated sockets.
 */

/** What the hub keeps with each socket (serializeAttachment). */
export type SocketInfo = {
  /** The owner's socket: it may receive private repos' events. */
  owner: boolean;
  /** When it connected (ms). */
  opened: number;
};

/** A socket as delivery sees it. */
export type LiveSocket = {
  info: SocketInfo | null;
  send(message: string): void;
  close(code: number, reason: string): void;
};

/**
 * Owner sockets are told to reconnect after this long, so that a signed-out
 * session stops receiving private events. Reconnecting checks it afresh.
 */
export const OWNER_SOCKET_MAX_AGE_MS = 60 * 60 * 1000;

/** The close code that asks the client to reconnect (and be authorized again). */
export const REAUTHORIZE = 4001;

/** True when a socket with `info` may see `message`. */
export function mayReceive(
  info: SocketInfo | null,
  message: Pick<LiveMessage, "private">,
): boolean {
  return !message.private || info?.owner === true;
}

/**
 * Send `message` to every socket allowed to see it. Owner sockets past their
 * age are closed instead (the client reconnects). Returns how many got it.
 */
export function deliver(sockets: LiveSocket[], message: LiveMessage, now = Date.now()): number {
  const text = JSON.stringify(message);
  let sent = 0;
  for (const ws of sockets) {
    try {
      if (ws.info?.owner && now - ws.info.opened > OWNER_SOCKET_MAX_AGE_MS) {
        ws.close(REAUTHORIZE, "reauthorize");
        continue;
      }
      if (!mayReceive(ws.info, message)) continue;
      ws.send(text);
      sent++;
    } catch {
      // A socket closing under us: skip it.
    }
  }
  return sent;
}
