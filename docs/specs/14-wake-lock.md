# Spec 14 — Screen wake lock (light spec)

**v1 — 2026-07-06 · Status: approved for build.**
Tier: light (client-only, no engine/protocol/server surface; delegated +
verified, no adversarial review round; targeted tests). Delivers the
wake-lock slice of the deferred Spec 07 polish bundle (QR join, sound/
haptics, history remain deferred). Baseline: `a1407dd`.

## Problem

Mafia is a glance-occasionally game: players go minutes without touching
their phone, the OS idle-lock fires (30s–2min on most phones), the mobile
browser suspends the tab and drops the WebSocket. The reconnect flow
recovers the seat correctly, but the human cost is a reload + banner +
re-orientation — and a night actor whose phone slept silently stalls the
whole game until they notice.

## Fix

Screen Wake Lock API (`navigator.wakeLock.request("screen")` — Chrome/
Android long-supported, iOS Safari 16.4+), held while the user is
participating in a room.

### Contract

- New hook `useWakeLock(active: boolean)` in the client (place & name per
  existing hook conventions in `src/client/`).
- **When active**: request a `screen` wake lock. The UA auto-releases the
  lock whenever the page becomes hidden (app switch, manual lock) — the
  hook MUST re-request on every `visibilitychange` back to `visible` while
  still active. Also handle the lock's own `release` event (e.g. UA revokes
  it) by re-requesting iff the page is visible and the hook is active.
- **When inactive / unmounted**: release the held lock and remove listeners.
  No leaked sentinels, no double requests (guard concurrent in-flight
  requests).
- **Activation condition**: active whenever the user holds a live seat in a
  connected room — player (lobby or in-game, alive or dead) and host
  console alike. Not active on the landing page or join/seat-picker
  screens. Wire it at the room-level component so it covers every phase.
- **Failure is silent**: feature-detect `"wakeLock" in navigator`; any
  rejection (NotAllowedError, etc.) is caught and at most `console.debug`'d.
  No UI, no error surface, no retry loop on failure (retry only rides the
  visibilitychange path). Old browsers simply keep today's behavior.
- No engine, protocol, or server changes. No ruleset field. No UI toggle
  (v1: always on while seated; battery cost is the point of the feature).

## Tests (land with the build)

- Unit tests for the hook with a mocked `navigator.wakeLock` (vitest,
  client project): acquires when active; re-acquires on visibilitychange
  → visible; does not re-acquire when inactive or hidden; releases on
  deactivate/unmount; silent when API missing or request rejects; no
  double-request race when toggled rapidly.
- No Playwright coverage (headless Chromium's wake-lock support is not
  meaningful) — instead assert via existing E2E that nothing regressed
  (suite stays green). Real-device verification: Tanner's next playtest;
  orchestrator checks prod for console errors and that the lock is
  requested (DevTools) on desktop Chrome.

## Non-goals

NoSleep.js/video fallbacks; a settings toggle; PWA manifest changes;
QR join, sound/haptics, history (still Spec 07 backlog).
