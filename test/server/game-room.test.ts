import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import type { PingMessage, ServerMessage } from "../../src/shared/protocol";

// Exercises the full server path: Worker WS route -> GameRoom Durable Object ->
// hibernatable WebSocket -> pong echo.
test("GameRoom echoes a pong for a ping over WebSocket", async () => {
  const res = await SELF.fetch("https://example.com/api/rooms/test/ws", {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);

  const ws = res.webSocket;
  expect(ws).toBeDefined();
  ws!.accept();

  const nonce = "nonce-123";
  const pong = new Promise<ServerMessage>((resolve, reject) => {
    ws!.addEventListener("message", (event: MessageEvent) => {
      resolve(JSON.parse(event.data as string) as ServerMessage);
    });
    ws!.addEventListener("error", () => reject(new Error("socket error")));
  });

  const ping: PingMessage = { type: "ping", nonce };
  ws!.send(JSON.stringify(ping));

  const reply = await pong;
  expect(reply).toEqual({ type: "pong", nonce });
  ws!.close();
});
