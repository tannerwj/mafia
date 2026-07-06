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

// Spec 16 D3: per-room invitation card + noindex. Matches the PAGE route
// `/room/XXXXX` (not `/api/rooms/...`) — case-insensitive since the URL may
// be typed/shared in lowercase, but the code is only ever used as a pure
// string transform (uppercased) after this matches. Never a DO lookup: the
// code was already public in the URL, so rewriting the card discloses
// nothing new, and skipping the room-existence check keeps this at zero
// added latency class.
const ROOM_PAGE_ROUTE = /^\/room\/([A-Za-z0-9]{5})\/?$/;

class RoomCardRewriter {
  constructor(private readonly code: string) {}
  element(element: Element): void {
    const property = element.getAttribute("property");
    const name = element.getAttribute("name");
    if (property === "og:title" || name === "twitter:title") {
      element.setAttribute("content", `You're invited to a game of Mafia — case ${this.code}`);
    } else if (property === "og:description" || name === "twitter:description") {
      element.setAttribute(
        "content",
        "Tap the link, sign the register, and try to survive the night. No app needed.",
      );
    } else if (property === "og:url") {
      element.setAttribute("content", `https://mafia.tannerwj.com/room/${this.code}`);
    }
  }
}

/**
 * Rewrites the SPA's index.html OG/Twitter card for a specific room code and
 * injects `<meta name="robots" content="noindex">`. Pure string/DOM
 * transform of the already-public URL code — no room-existence check, no DO
 * traffic. Non-HTML/non-matching requests are handled by the caller before
 * this is ever invoked.
 */
function rewriteRoomCard(assetResponse: Response, code: string): Response {
  return new HTMLRewriter()
    .on('meta[property="og:title"]', new RoomCardRewriter(code))
    .on('meta[property="og:description"]', new RoomCardRewriter(code))
    .on('meta[property="og:url"]', new RoomCardRewriter(code))
    .on('meta[name="twitter:title"]', new RoomCardRewriter(code))
    .on('meta[name="twitter:description"]', new RoomCardRewriter(code))
    .on("head", {
      element(element) {
        element.append('<meta name="robots" content="noindex">', { html: true });
      },
    })
    .transform(assetResponse);
}

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

    // Spec 16 D3: per-room invitation card. Only GET + text/html requests to
    // the room PAGE route (not /api/rooms/...) are rewritten; everything
    // else (assets, non-matching paths, non-HTML accept) falls through to
    // the asset layer completely untouched. `run_worker_first` in
    // wrangler.jsonc is what makes the Worker see this request at all
    // instead of the SPA fallback asset serving it directly.
    const roomPageMatch = ROOM_PAGE_ROUTE.exec(url.pathname);
    if (roomPageMatch && request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html")) {
      const code = roomPageMatch[1]!.toUpperCase();
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.headers.get("content-type")?.includes("text/html")) {
        return rewriteRoomCard(assetResponse, code);
      }
      return assetResponse;
    }

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
        // A non-OK / non-JSON claim response (e.g. a transient DO storage
        // error under contention) must not throw an opaque 500 out of the
        // create-room entry point — treat it as a failed attempt and retry
        // with a fresh code, falling through to could_not_allocate_room.
        if (!claimRes.ok) continue;
        const result = (await claimRes.json().catch(() => null)) as
          | { status: "claimed"; hostKey: string }
          | { status: "taken" }
          | null;
        if (result?.status === "claimed") {
          return json({ roomCode: code, hostKey: result.hostKey }, 201);
        }
        // "taken" or an unreadable body — retry with a fresh code.
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

    if (!url.pathname.startsWith("/api/")) {
      // Not an API route: hand off to the assets binding rather than 404.
      // In production this line is normally dead code — Cloudflare's asset
      // router serves unmatched non-API paths before the Worker ever runs —
      // but `run_worker_first: ["/room/*"]` (Spec 16 D3) plus test
      // environments that always invoke the Worker directly (no separate
      // asset-router hop) mean the Worker itself must know how to fall
      // through, or every non-API GET it happens to see 404s instead of
      // serving the SPA/static files.
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
