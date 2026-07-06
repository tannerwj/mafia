# Spec 14 implementation notes — screen wake lock

Baseline: `a1407dd`. Client-only build, no engine/protocol/server/E2E touched.

## What was built

- `src/client/net/wakeLock.ts` — `WakeLockManager`, a plain class (no React,
  no globals — deps injected via constructor) that owns at most one
  `WakeLockSentinel` at a time:
  - `setActive(true)` requests a `screen` lock and starts listening for
    `visibilitychange`.
  - `setActive(false)` releases the held lock and stops listening.
  - `dispose()` is `setActive(false)` plus intent-to-unmount (same effect;
    kept as a named method for hook-cleanup readability).
  - Re-requests on `visibilitychange` → `visible` while still active, and
    on the sentinel's own `release` event while active+visible (covers a
    UA revoking the lock outside the visibility path, per spec).
  - `requesting` flag guards overlapping in-flight `request()` calls (rapid
    toggle / overlapping visibility+release triggers can't double-request).
  - A grant that resolves after the manager went inactive is released
    immediately rather than kept (stale-grant race).
  - Feature-detects `navigator.wakeLock`; any rejection is caught and
    swallowed (no `console.debug` call added in the end — see deviation
    below).
  - Placed next to `RoomConnection.ts` in `src/client/net/` since it's the
    same shape of thing: a plain class managing a browser API's lifecycle,
    constructed with injected deps so it's unit-testable under this
    project's jsdom-less client test environment (`vitest.config.ts`
    comment + `RoomConnection.test.ts` header explain why: no
    jsdom/testing-library in the dependency budget).

- `src/client/useWakeLock.ts` — thin hook wrapper: `useWakeLock(active:
  boolean)`. Builds one `WakeLockManager` per component instance (lazy
  `useRef` init), forwards `active` to `setActive` on change, and calls
  `dispose()` on unmount. Placed at `src/client/` top level next to
  `useRoute.ts` (no dedicated `hooks/` directory exists yet in this repo;
  matched the existing flat convention rather than inventing one).

- `src/client/screens/Room.tsx` — one call added: `useWakeLock(phase.name
  === "connected")`. `"connected"` is the phase that covers lobby through
  game end, for both the player and host-console code paths (it's checked
  before branching on `phase.isHost`), matching the spec's "live seat in a
  connected room — player (lobby or in-game, alive or dead) and host
  console alike" activation condition. Not active during
  `resolving-auth`/`picking-seat`/`choosing-identity`/`offering-host-recovery`/
  `kicked`/`bad-credential`/`not-found`.

## Tests

`test/client/wakeLock.test.ts`, 12 tests, all against `WakeLockManager`
directly (hand-rolled fake `navigator`/`document` per the constructor's
injected interfaces — no rendering, consistent with this project's other
client unit tests):
- requests on activate
- re-acquires on visibilitychange → visible (simulating the UA firing the
  sentinel's own `release` event on hide, same as a real browser, then the
  visibility flip back)
- re-acquires when the sentinel's `release` event fires directly while
  active+visible
- does NOT re-acquire on visibilitychange while never activated
- does NOT re-acquire on a redundant visibilitychange while still hidden
- releases on `setActive(false)`
- releases + stops listening on `dispose()` (post-dispose visibility
  changes provably do nothing)
- silent (no throw) when `navigator.wakeLock` is absent
- silent (no throw) when `request()` rejects
- no double in-flight request when toggled true/false/true before the
  first request resolves; the eventually-resolved grant is kept (net
  active state at resolution time is active)
- a grant that resolves after `setActive(false)` was called is released
  immediately (stale-grant race)
- calling `setActive(true)` twice in a row issues only one request

## Deviations from the spec

- Spec says failure handling is "any rejection is caught and at most
  `console.debug`'d." Implemented as caught-and-swallowed with no
  `console.debug` call at all — "at most" reads as making the debug log
  optional, and a silent catch is strictly quieter/simpler with the same
  observable behavior (no UI, no throw). Flagging in case the orchestrator
  wants the debug breadcrumb added back for real-device troubleshooting;
  trivial one-line addition in `WakeLockManager`'s two catch blocks if so.
- No dedicated `src/client/hooks/` directory was created — `useWakeLock.ts`
  sits at `src/client/` top level next to the only existing precedent
  (`useRoute.ts`). If a future spec wants a `hooks/` directory, both should
  probably move together rather than splitting the convention.

## Verification

`npm run typecheck && npm test` (fresh run, this tree):
- typecheck: clean, no errors.
- test: **251 passed, 0 failed** — engine 170, client 32 (12 new wake-lock
  + 20 pre-existing), server 49.

Tree left uncommitted per instructions.

STATUS: COMPLETE
