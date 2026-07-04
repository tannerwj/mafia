// Worker entry point.
//
// Spec 00 scope: route the WebSocket upgrade to a GameRoom Durable Object and
// stub the REST surface. Static asset serving is handled by the Cloudflare
// Vite plugin / [assets] binding, so anything that is not an /api route falls
// through to assets automatically.
export { GameRoom } from "./game-room";

const WS_ROUTE = /^\/api\/rooms\/([^/]+)\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade: /api/rooms/:id/ws -> GameRoom DO for that room id.
    const wsMatch = WS_ROUTE.exec(url.pathname);
    if (wsMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const roomId = decodeURIComponent(wsMatch[1]!);
      const stub = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(roomId));
      return stub.fetch(request);
    }

    // Room lifecycle REST surface — implemented in Spec 01.
    if (url.pathname === "/api/rooms") {
      return new Response(
        JSON.stringify({ error: "not_implemented" }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
