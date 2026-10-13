import { DurableObject } from "cloudflare:workers";
import type { LiveHello, LiveMessage } from "../shared/live.js";
import { deliver, type SocketInfo } from "./deliver.js";
import { OWNER_HEADER } from "./publish.js";

/**
 * LiveHub: the WebSockets of one scope, a repo (`idFromName("repo:<name>")`)
 * or the whole instance (`idFromName("instance")`). Uses the hibernation API,
 * so open browsers cost nothing while nothing happens. The Worker authorizes
 * every socket before it gets here (src/api/routes/live.ts); `publish`
 * (src/live/publish.ts) calls `broadcast`. One-way: clients only ping.
 */
export class LiveHub extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    // Keepalive pings are answered without waking a hibernated hub.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const info: SocketInfo = {
      owner: request.headers.get(OWNER_HEADER) === "1",
      opened: Date.now(),
    };
    server.serializeAttachment(info);
    const scope = new URL(request.url).searchParams.get("scope") ?? "";
    server.send(JSON.stringify({ type: "hello", scope, owner: info.owner } satisfies LiveHello));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Send one event to every socket that may see it. Returns how many got it. */
  async broadcast(message: LiveMessage): Promise<number> {
    const sockets = this.ctx.getWebSockets().map((ws) => ({
      info: ws.deserializeAttachment() as SocketInfo | null,
      send: (m: string) => ws.send(m),
      close: (code: number, reason: string) => ws.close(code, reason),
    }));
    return deliver(sockets, message);
  }

  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
  }
}
