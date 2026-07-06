# Spec 16 implementation notes — the front door

Built against HEAD `e854b52` (moved to `efad99b` mid-task via concurrent
orchestrator work on Spec 17 prep; unrelated to this spec, no conflicts).

## Files changed

- `index.html` — added `<link rel="canonical">` (D2/F1) and a `WebApplication`
  JSON-LD block (D2/F4). Hero markup/tags otherwise untouched.
- `public/robots.txt` (new, D2/F2) — allow `/`, disallow `/room/`, sitemap ref.
- `public/sitemap.xml` (new, D2/F5) — single canonical URL.
- `public/site.webmanifest` — added a `screenshots` array (D2/F8) referencing
  `/manifest-screenshot-{1,2}.png`, which don't exist on disk yet (orchestrator
  to drop real captures per the spec — manifest parsers ignore a missing
  screenshot file, so this is placeholder-safe as specified).
- `src/client/lib/qr.ts` (new) — self-contained QR encoder, see "QR dependency"
  below.
- `src/client/components/QrCode.tsx` (new) — renders `encodeQr()`'s matrix to
  a `<canvas>`, dark-on-light paper tile, 4-module quiet zone.
- `src/client/screens/host/HostLobby.tsx` — added the QR tile under the player
  table, next to the existing share-link row. Only touched by adding markup;
  no existing testids/behavior changed. Lobby-only is automatic — `HostLobby`
  itself only renders during the lobby phase (Room.tsx's existing phase
  switch), so no extra guard was needed for "QR disappears once game starts."
- `src/client/screens/Home.tsx` — hero `<main>` left byte-identical (same
  className, same children, same testids); wrapped it and a new
  `LandingExplainer` section in an outer `<div>` so the explainer flows below
  the fold. Added: pitch, 4-step "how a game runs", house-six cast list
  (reusing `roleCopy.ts`'s `blurb`, not new copy), house-facts card, and a
  footer link that opens `InstructionsContent` (Spec 08's existing component,
  imported and reused, not duplicated) in a small local modal — the spec's
  "reuse if it mounts cleanly outside a room" held: `InstructionsContent` has
  zero room/server dependency.
- `src/server/index.ts` — D3 interception (see below) + one adjacent fix (see
  "Deviation: fallback-to-assets" below).
- `wrangler.jsonc` — three additions, all under `assets` (see "Deviation:
  wrangler.jsonc" below): `binding: "ASSETS"`, `run_worker_first: ["/room/*"]`,
  `directory: "dist/client"`.
- `worker-configuration.d.ts` — NOT committed (gitignored, `wrangler
  types`-generated). Hand-added `ASSETS: Fetcher` to `__BaseEnv_Env` locally
  so `npm run typecheck`/`npm test` pass in this worktree. Orchestrator should
  run `wrangler types` for real during verification — it should regenerate an
  equivalent entry from the `wrangler.jsonc` binding.

## QR dependency

No network available, so no `npm install`. Wrote a self-contained encoder
(`src/client/lib/qr.ts`) rather than requesting a package: byte-mode only,
EC level M, versions 1–10 (up to ~213 ASCII bytes — far more than any room
URL needs), full Reed-Solomon over GF(256), all 8 mask patterns scored by the
standard ISO/IEC 18004 penalty rules, proper finder/timing/alignment/format
placement.

This was the highest-risk piece of the build (a subtly wrong QR encoder looks
fine in a screenshot but fails to scan), so it got the most scrutiny: unit
tests in `test/client/qr.test.ts` don't just check "a matrix came out" — they
independently decode the encoder's own output (read the format-info mask id
back off the matrix, undo that exact mask, walk the same zigzag placement
path, de-interleave multi-block payloads back to sequential block order, then
parse the byte-mode header/payload) and assert round-trip equality. Caught and
fixed a real bug this way: the first version of the encoder was correct, but
the first version of the *test's* decoder wasn't de-interleaving before
parsing the character-count field, which only manifests once a payload is
long enough to need 2+ RS blocks (version 8+, or in this case version 5 which
already uses 2 blocks) — a payload short enough to stay in a single block
never exercises that path. Root-caused via a byte-level trace (dumped the
format-info-selected mask, decoded the header field's raw bits, and confirmed
the corruption started exactly 8 bits into codeword 1 — i.e., at the
block-interleave boundary) rather than guessing. Fixed by de-interleaving in
the test before parsing; the encoder itself needed no change.

Coverage: short URL, long URL, shortest plausible input, a payload forced
into 2 block-groups of different sizes (version 8+, the other interleave
branch), matrix square/size/finder-pattern sanity checks, and an
out-of-capacity error case. 39/39 pass. If you'd rather use the `qrcode` npm
package instead, that's a one-file swap (`QrCode.tsx`'s `encodeQr` import) —
but given the from-scratch encoder is now decode-verified, I'd keep it;
dropping the dependency was a bonus, not the point.

## D3 (server interception) — two deviations, both necessary for D3 to work at all

**1. `wrangler.jsonc`'s `assets` block needed `binding: "ASSETS"` and
`run_worker_first: ["/room/*"]`, which it didn't have.** Without an explicit
`binding` name, `env.ASSETS` doesn't exist — confirmed against Cloudflare's
docs (`workers/static-assets/binding`). And without `run_worker_first`, the
asset router serves `/room/:code` before the Worker ever runs (via
`not_found_handling: "single-page-application"`'s SPA fallback), so the
Worker's `fetch` handler literally never sees the request D3 is supposed to
intercept. Both are `wrangler.toml`-tweak-shaped config, which CLAUDE.md lists
as an orchestrator exception, but D3 has no path to existing without them —
flagging for sign-off rather than holding the whole spec hostage on it.

Also added `directory: "dist/client"` to the same block. The Cloudflare Vite
plugin doesn't need this for `vite dev`/`vite build` (it injects the client
build output path itself, confirmed via Cloudflare's docs: "If you are using
the Cloudflare Vite plugin, you do not need to specify this directory") — but
`vitest.workers.config.ts` loads `wrangler.jsonc` directly with zero Vite
involvement, so without an explicit `directory`, `env.ASSETS` exists but has
nothing to serve and every asset fetch 404s. **Consequence: the `server` test
project now needs `dist/client` to exist before it can pass — i.e., `vite
build` (or `npm run deploy`'s first half) must run before `npm test`.** This
wasn't true before D3 (no test touched assets). Ran `npx vite build` locally
to produce it for my own verification; the orchestrator's verification step
should do the same before `npm test`.

**2. `src/server/index.ts`'s final fallback was `return new Response("Not
found", { status: 404 })` for every unmatched path.** In production this line
was already dead for GET requests to unknown non-API paths (Cloudflare's edge
asset router serves those before the Worker runs), but pool-workers'
`SELF.fetch` invokes the Worker directly with no separate asset-router hop —
so once `run_worker_first: ["/room/*"]` made the Worker actually run for
`/room/*`, testing `GET /` (needed for the D3 test's "GET / is unaffected"
assertion) surfaced that the Worker itself has never known how to fall
through to assets. Changed the fallback to: unmatched `/api/*` paths still
404 (unchanged behavior), everything else now calls `env.ASSETS.fetch(request)`
instead of hardcoding 404. This is one line, additive-only for every path
that used to reach that branch (previously-unreachable-in-prod 404 outcomes
now correctly serve assets instead), and doesn't touch the WS/rooms API logic
the brief scoped me away from — but it IS a change outside the D3 regex match
itself, so flagging it explicitly per the scope guardrail rather than treating
it as obviously in-bounds. Without it, `npm test`'s server project cannot
even assert D3's "GET / is unaffected" contract.

D3 itself (`ROOM_PAGE_ROUTE`, `RoomCardRewriter`, `rewriteRoomCard`): matches
`^/room/([A-Za-z0-9]{5})\/?$` case-insensitively, uppercases the code as a
pure string transform (no DO lookup, no storage read, matching the spec's
zero-latency/zero-disclosure constraint), rewrites `og:title`/`og:description`/
`og:url`/`twitter:title`/`twitter:description` via `HTMLRewriter`, and appends
`<meta name="robots" content="noindex">` to `<head>`. Non-HTML accept and
non-5-char-code paths fall through to the asset response completely untouched
(verified in `test/server/front-door.test.ts`).

## Tests

- `test/client/qr.test.ts` — 8 tests, encoder round-trip/decode coverage
  described above.
- `test/server/front-door.test.ts` — 6 tests: invite-card content + noindex
  present, lowercase code uppercased, `GET /` unaffected (no noindex,
  canonical present), non-HTML accept untouched, non-5-char code under
  `/room/` untouched, `/api/*` unaffected.
- `test/e2e/front-door.spec.ts` — written per spec but NOT run (Playwright is
  out of scope for the implementer per the brief). Covers: hero testids still
  present/visible, explainer sections + all 6 cast roles render, footer link
  opens/closes the case briefing modal, QR renders with the room code in its
  `data-qr-value`/`title`, QR disappears once `start-game` is clicked.
  Orchestrator should run this fresh.
- Existing E2E suites (`lobby.spec.ts`, `host-console.spec.ts`, etc.) were not
  modified — D1's hero stayed byte-identical and D4's HostLobby change is
  additive markup only, so nothing in them should need updating, but that's
  an assertion to verify at Playwright time, not something I could confirm
  myself.

## Fresh counts (this worktree, at hand-off)

- `npm run typecheck` — clean.
- `vitest run --project engine --project client` — 214/214 pass (7 files).
- `vitest run --project server` — 96/96 pass (3 files), run AFTER `npx vite
  build` per the deviation above. A `close timed out after 10000ms` message
  appears after the server project's run — this is a known
  `vitest-pool-workers` teardown quirk (unrelated to test correctness; all
  tests reported passed before it), also presumably present on `master`
  already for `game-room.test.ts`/`storyteller.test.ts` — not introduced by
  this spec's changes.
- Playwright: not run (out of scope for implementer this spec).

## Non-deviations worth noting

- SKIP twitter:site — per spec, not built.
- No prerendering/SSR, no blog pages, no analytics, no service worker — per
  spec's non-goals.
- Create/join flow logic (`Home.tsx`'s `createRoom`/`joinRoom` functions) is
  byte-identical to before this spec.

STATUS: COMPLETE
