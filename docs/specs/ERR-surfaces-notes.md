# Silent join errors — fix + E2E hardening

Playtest feedback: several user-facing errors were failing silently. Scope
was client-only (`src/client` + `test/e2e`); server/engine untouched.

## 1. Bad room code on Home — FIXED

`Home.tsx`'s `joinRoom()` navigated to `/room/:code` unconditionally, with no
check the room existed. A nonexistent code just landed the user on a Room
page stuck retrying a WebSocket upgrade that 404s forever — no message,
ever (`home-error`, already rendered, was never set).

Fix: `joinRoom()` now normalizes the code (trim + uppercase, matching
`useRoute.ts`'s own normalization) and calls the room's existing
`GET /api/rooms/:code` endpoint (`src/server/index.ts:83-95` — was already
implemented server-side, just never called from Home) before navigating.
- 404 / `{exists:false}` → `home-error` shows "No case file with that code —
  check it and try again." and the user stays on Home.
- Network failure on the check itself → a distinct message ("Could not
  reach the office…"), never a silent no-op.
- Only success navigates.
- Join button shows "Checking the file…" and disables during the lookup to
  prevent double-submits; the GET is a single fast round trip so this
  doesn't feel like a stall in practice.

## 2. Direct navigation to a bad `/room/:code` — FIXED

Confirmed silent before this fix: opening `/room/BADCODE` directly (a
pasted/shared bad link) put `Room.tsx` into `resolving-auth` →
`picking-seat`, which opens a WebSocket to a room the DO has never claimed.
That upgrade 404s, which is not a terminal close code in
`RoomConnection.ts`, so the client just retries forever under normal
backoff — blank/spinner state, no message, no way out except manually
editing the URL.

Fix: added a `not-found` phase to `Room.tsx`. On mount, the existing
auth-resolution path (`resolveAuth()`) still starts **immediately and
synchronously**, exactly as before — no added latency on the happy path.
In parallel, a `GET /api/rooms/:code` existence check runs; if it comes
back 404 / `exists:false`, the phase is overridden to `not-found`, which
renders a clear screen (`room-not-found` testid) with a "Back to the
office" button. A network failure on this check is treated as
inconclusive and deliberately does nothing — the WS connection's own
reconnect/backoff is a fairer arbiter of a transient network blip than a
one-off GET, so it doesn't wrongly declare a real room missing.

Implementation note / regression caught during verification: the first
version of this fix gated `resolveAuth()` *behind* the existence-check
`fetch()` (check-then-resolve, sequential). That silently added one
network round trip before the seat picker/backup list ever mounted, which
broke the timing-sensitive `isVisible()`-then-`fill()` pattern used by
`lobby.spec.ts`'s existing `joinAsPlayer()` helper (and would have
regressed `game.spec.ts`/`game-reconnect.spec.ts`, which share it) —
`test/e2e/lobby.spec.ts`'s "two pages in one browser context are two
distinct players" started timing out at 120s. Fixed by racing the two
instead of sequencing them (`resolveAuth()` call moved before the
`fetch()`, not inside its `.then()`). Full suite re-verified green after
the fix (see below) — flagging this here since it's the kind of
regression that's easy to reintroduce if this code is touched again.

## 3. Blank / >20-char name on the join form

- **Blank name: was silent, now FIXED.** `SeatPicker.tsx`'s
  `submitJoinNew()` just did `if (trimmed.length === 0) return;` — a no-op,
  no message, so a blank submit looked like the button didn't work. Now
  sets a local `nameError` state rendered as a new `join-name-error` testid
  ("Enter a name before joining."), cleared as soon as the user types.
- **>20 chars: already handled, no change needed.** The input already has
  `maxLength={20}` (Spec 01), so it's physically impossible to type or
  paste-and-have-it-register more than 20 characters — there's nothing for
  the server's `invalid_name` rejection to ever catch in the real client
  flow. Not silent; just unreachable, which is the correct outcome.

## 4. Already-working error surfaces (verified, not touched)

Per the task brief these were confirmed live on current code and
intentionally left alone — only test coverage was added:
- Duplicate name (separate device, same-browser second tab, and
  case-insensitive) → `room-error` "That name is already taken." + stays on
  the join form.
- Joining after the game has started → `room-error` "Cannot join once the
  game has started."

## New tests — `test/e2e/error-surfaces.spec.ts`

6 new Playwright tests, each asserting the message/screen is actually
**visible** to the user (not just that a request round-tripped):
1. Bad room code on Home → `home-error` visible with text, stays on `/`.
2. Duplicate name, separate browser context → `room-error` visible, still
   on join form, never joined (`player-list` has 0 count).
3. Duplicate name, second tab in the same context (seat-backup path) →
   `room-error` visible.
4. Case-insensitive duplicate ("vinny" vs "Vinny") → `room-error` visible.
5. Join after game started (5 players, house ruleset's real minimum) →
   `room-error` visible with the exact copy.
6. Direct nav to a nonexistent `/room/:code` → `room-not-found` visible,
   "Back to the office" button returns to `/`.

## Verification

- Killed stray `vite`/`workerd` processes, `rm -rf .wrangler/state`, started
  one dev server, confirmed 200s, then ran Playwright.
- `npx playwright test --workers=1` (full suite, all files): **38/38
  passed**, ~3.4 min. No regressions in `lobby.spec.ts`, `game.spec.ts`,
  `game-reconnect.spec.ts`, `game-components.spec.ts`, `host-console.spec.ts`,
  `lockin-role-instructions.spec.ts`.
- `npm run typecheck`: clean.
- `npm test` (vitest, engine + client + server projects): **40 + 10 + 40 =
  90 passed**. (A `EnvironmentTeardownError` / `Closing rpc while "resolve"
  was pending` message prints after the server project's run — confirmed
  pre-existing on `master` via `git stash`, unrelated to this change; it's
  vitest/workerd teardown noise after tests already report passed, not a
  failure.)

STATUS: complete, suites green.
