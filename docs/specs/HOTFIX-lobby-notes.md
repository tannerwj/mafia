# Hotfix: share-link silent failure + wrong start-gate minimum

Live user-facing hotfix (deployed target: mafia.tannerwj.com). Two confirmed
client-side lobby bugs blocking a real game. Client-only; `src/server` and
`src/engine` game logic untouched (one build-config include was added for the
client to reference the engine's `validateRuleset`).

## Bug 1 — "Share link" button was a silent no-op on mobile

**Cause.** `Room.tsx` `handleCopyLink()` was
`void navigator.clipboard?.writeText(url)`. On mobile Safari (and any
permission-denied context) `writeText` rejects with "Write permission denied";
the `void` swallowed the rejection, so the button did nothing — read by the
host as "not clickable".

**Fix.** Extracted the logic into a pure, testable helper
`src/client/lib/shareLink.ts` → `shareOrCopyLink(url, feedback, nav?)` that
degrades in order and NEVER dead-ends:

1. `navigator.share({ title: "Join my Mafia game", url })` if present — the
   ideal phone path (native share sheet; host texts/AirDrops the link). A
   user-cancelled sheet throws `AbortError`, which is treated as a silent
   non-failure (no toast, no fallback).
2. Else / on a non-abort share error: `navigator.clipboard.writeText(url)` with
   a visible success toast ("Link copied!") via sonner (reusing the store's
   existing toast wiring — `Room.tsx` now imports `toast` from `sonner`).
3. If BOTH fail: surface the URL for manual copy. `Room.tsx` renders a new
   `ManualShareLink` fixed-bottom panel (`data-testid="manual-share-link"`)
   containing a read-only, pre-selected, `select-all` input
   (`data-testid="manual-share-url"`) the host can long-press-copy, plus a
   "Done" dismiss. Shown in both the host and player connected views.

`data-testid="copy-link"` on the button is preserved. One handler covers both
HostLobby and the player Lobby (both route through `Room.tsx`).

## Bug 2 — Start gate used a hardcoded minimum of 3, but HOUSE_RULES needs 5

**Cause.** `HostLobby.tsx` hardcoded `MIN_PLAYERS = 3`. The house ruleset's
fixed role counts (detective/angel/suicide_bomber = 1 each, mafia+villager
auto) only validate at ≥5 players — verified: `validateRuleset(HOUSE_RULES, n)`
returns `role_count_mismatch` for n=1..4 and is clean for n=5..12+. So a host
with 3-4 players saw an ENABLED "Start game" that then failed server-side
validation with a confusing error.

**Fix.** `canStart` now mirrors the server's own check:
`validateRuleset(HOUSE_RULES, state.players.length).errors.length === 0`
(imported from the engine public entry `../../../engine`). The disabled-button
copy states the real requirement: `Need at least N players`, where N is probed
(`minPlayersForHouse()`, capped at 20) rather than hardcoded, so it stays
honest if the ruleset's fixed role counts change. The host is a pure
arbitrator (not a player), so `state.players.length` is the correct seat count
the gate validates against.

**Build config.** The client tsconfig previously excluded `src/engine`
(architecture: `engine → shared`, client → shared only). Referencing
`validateRuleset`/`HOUSE_RULES` required adding `src/engine` to
`tsconfig.client.json`'s `include` (the engine is pure — no
Cloudflare/DO/server deps — so this is safe; it mirrors `tsconfig.server.json`,
which already includes `src/engine`). `src/client/lib` was added to
`tsconfig.client-test.json` so the new unit test can import the share helper.

## Tests added

- `test/client/shareLink.test.ts` (6 unit tests, Node/no-jsdom, same posture as
  `RoomConnection.test.ts`): share-sheet success; AbortError = silent cancel;
  clipboard fallback + toast; non-abort share error → clipboard; **clipboard
  rejects + no share → manual URL surfaced (the core regression)**; neither API
  present → manual.
- `test/e2e/host-console.spec.ts`:
  - "share link degrades gracefully when clipboard is denied" — `addInitScript`
    removes `navigator.share` and makes `clipboard.writeText` reject; click
    `copy-link`; assert `manual-share-link` becomes visible with the room URL
    (proves no silent failure).
  - "start gate reflects the real house-ruleset minimum" — join 4 players,
    assert `start-game` DISABLED with "Need at least 5 players"; join the 5th,
    assert ENABLED with "Start game".

Existing e2e tests already join 5 players, so none assumed the old 3-min gate
and none needed updating.

## Verification (clean env: killed stray vite/workerd, `rm -rf .wrangler/state`, `--workers=1`)

- `npm run typecheck` — clean.
- `npm test` — 72 passed (engine 27, client 10, server 35).
- `npx playwright test --workers=1` — 26 passed (full suite, single clean run).

Not committed and not deployed — left for the orchestrator to redeploy.

STATUS: hotfix complete, suites green
