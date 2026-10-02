// Spec 16 D3: per-room invitation card + noindex. Runs through the real
// Worker fetch handler in workerd (same SELF.fetch pattern as
// game-room.test.ts) so this exercises the actual `wrangler.jsonc`
// `run_worker_first: ["/room/*"]` routing + `env.ASSETS` binding, not a
// mock — if that config regresses, this test is what catches it.
import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

describe("D3: per-room invitation card", () => {
  test("GET /room/ABCDE with Accept text/html gets the invite card + noindex", async () => {
    const res = await SELF.fetch("https://example.com/room/ABCDE", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("You're invited");
    expect(body).toContain("ABCDE");
    expect(body).toContain('<meta name="robots" content="noindex">');
  });

  test("lowercase room code in the URL is uppercased in the rewritten card", async () => {
    const res = await SELF.fetch("https://example.com/room/abcde", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("ABCDE");
    expect(body).not.toContain("case abcde");
  });

  test("GET / is unaffected — no noindex, canonical still present", async () => {
    const res = await SELF.fetch("https://example.com/", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("noindex");
    expect(body).toContain('rel="canonical"');
  });

  test("GET /room/ABCDE with non-HTML accept falls through untouched", async () => {
    const res = await SELF.fetch("https://example.com/room/ABCDE", {
      headers: { Accept: "application/json" },
    });
    // Falls through to the asset layer's own behavior for a non-HTML accept
    // on an SPA route — not a 500, and definitely not our rewrite (no
    // "You're invited" injected into whatever comes back).
    const body = await res.text();
    expect(body).not.toContain("You're invited");
  });

  test("a non-room-shaped path under /room/ is not rewritten", async () => {
    const res = await SELF.fetch("https://example.com/room/TOOLONGCODE", {
      headers: { Accept: "text/html" },
    });
    const body = await res.text();
    expect(body).not.toContain("You're invited");
  });

  test("/api/* is unaffected by the D3 interception", async () => {
    const res = await SELF.fetch("https://example.com/api/rooms/ABCDE");
    // Falls through to the existing room-lookup route (404 for an unclaimed
    // code), never touched by the HTML rewrite path.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { exists: boolean };
    expect(body.exists).toBe(false);
  });

  test("malformed or off-alphabet room codes return 400 without a DO lookup", async () => {
    const malformed = await SELF.fetch("https://example.com/api/rooms/%ZZ");
    expect(malformed.status).toBe(400);
    const offAlphabet = await SELF.fetch("https://example.com/api/rooms/AAAAI");
    expect(offAlphabet.status).toBe(400);
  });
});
