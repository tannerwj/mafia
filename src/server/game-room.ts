import { DurableObject } from "cloudflare:workers";
import type {
  ClientMessage,
  ServerMessage,
} from "../shared/protocol";

// GameRoom Durable Object.
//
// Spec 00 scope: prove the hibernatable WebSocket path end to end. It accepts a
// WebSocket via the Hibernation API and answers each `ping` with a `pong`
// carrying the same nonce. No game state yet — Spec 01 introduces identity,
// snapshots, and the real protocol; Spec 03 wires in the engine.
export class GameRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    // acceptWebSocket (not server.accept) opts the socket into hibernation:
    // the DO can be evicted between messages and the socket survives.
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      // Spec 00 protocol is JSON text only.
      return;
    }

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }

    if (parsed.type === "ping") {
      const reply: ServerMessage = { type: "pong", nonce: parsed.nonce };
      ws.send(JSON.stringify(reply));
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Echo the peer's close code, but 1005/1006/1015 are reserved codes that
    // may surface here yet cannot be sent in a Close frame — normalize to 1000.
    const RESERVED = new Set([1005, 1006, 1015]);
    const closeCode =
      code >= 1000 && code < 5000 && !RESERVED.has(code) ? code : 1000;
    ws.close(closeCode);
  }
}
