// Worker entry point.
//
// Routes the room lifecycle REST surface and forwards the WebSocket upgrade
// to the GameRoom Durable Object for that room code. Static asset serving is
// handled by the Cloudflare Vite plugin / [assets] binding, so anything that
// is not an /api route falls through to assets automatically.
export { GameRoom } from "./game-room";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 5;
const MAX_CLAIM_ATTEMPTS = 5;

const WS_ROUTE = /^\/api\/rooms\/([^/]+)\/ws$/;
const ROOM_ROUTE = /^\/api\/rooms\/([^/]+)$/;

function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade: /api/rooms/:code/ws -> GameRoom DO for that code.
    const wsMatch = WS_ROUTE.exec(url.pathname);
    if (wsMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const code = decodeURIComponent(wsMatch[1]!).toUpperCase();
      const stub = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(code));
      // The DO's own /internal/ws handler is authoritative on room
      // existence (404s if unclaimed) — no need to pre-check here.
      const upgradeReq = new Request("https://do/internal/ws", request);
      return stub.fetch(upgradeReq);
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        hostName?: string;
      };
      void body; // hostName reserved for a future spec; not persisted yet.

      for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
        const code = generateRoomCode();
        const stub = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(code));
        const claimRes = await stub.fetch("https://do/internal/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const result = (await claimRes.json()) as
          | { status: "claimed"; hostKey: string }
          | { status: "taken" };
        if (result.status === "claimed") {
          return json({ roomCode: code, hostKey: result.hostKey }, 201);
        }
        // "taken" — retry with a fresh code.
      }

      return json({ error: "could_not_allocate_room" }, 500);
    }

    const roomMatch = ROOM_ROUTE.exec(url.pathname);
    if (roomMatch && request.method === "GET") {
      const code = decodeURIComponent(roomMatch[1]!).toUpperCase();
      const stub = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(code));
      const metaRes = await stub.fetch("https://do/internal/meta");
      const meta = (await metaRes.json()) as
        | { exists: false }
        | { exists: true; phase: string };
      if (!meta.exists) {
        return json({ exists: false }, 404);
      }
      return json(meta, 200);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
