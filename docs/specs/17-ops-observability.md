# Spec 17 — Ops: observability + lifecycle hardening

**v1 — 2026-07-06 · Status: approved for build (Tanner polish slate).**
Tier: medium (server-wide but not leak-critical — logs/metrics are
operator-only; the LOG HYGIENE rule below is the one secret-adjacent
surface and it's pinned + unit-tested; no adversarial round). Grounded in
the 2026-07-06 ops audit (docs/specs — see STATUS). Builds AFTER Spec 16
lands (both touch src/server/index.ts — never concurrently).

Fact corrections vs the audit (verified against Cloudflare docs
2026-07-06): Workers Logs `head_sampling_rate` UNSPECIFIED defaults to
**1 (100%)**, not 1%; retention 3d free / 7d paid. So `console.*` from the
DO/worker is already fully captured — we simply emit nothing today.

## Problem

The server emits ZERO logs (no console.* anywhere in src/server), all
error paths swallow silently, there are no metrics, and the client has no
error reporting. "The narrator AI stopped working" is currently
undiagnosable. Cleanup is healthy (nothing outlives the 6h TTL wipe) but
has small hardening gaps.

## D1 — Structured server logging

One tiny helper (src/server/log.ts): `logEvent(event: string, fields:
Record<string, unknown>): void` → `console.log(JSON.stringify({ evt:
event, ...fields }))`. Never throws (wrap), never awaited.

Emit at (with fields; roomCode on everything room-scoped):

- `room_claimed` {roomCode}
- `game_started` {roomCode, playerCount, roleCounts (aggregate counts per
  roleId — NEVER per-player assignments)}
- `game_ended` {roomCode, winners, reason, day, durationMs}
- `room_wiped` {roomCode, reason: "empty_lobby"|"absolute_ttl"|"ended_ttl",
  idleMs}
- `ws_open` {roomCode, authKind} · `ws_close` {roomCode, authKind, code,
  wasClean} · `ws_error` {roomCode}
- `auth_rejected` {roomCode, reason}
- `msg_slow` {roomCode, type, ms} — only when handling exceeds 50ms
- `story_generate` {roomCode, beat, outcome:
  "ok"|"timeout"|"parse_fail"|"model_error"|"rate_limited"|"busy"|
  "stale"|"wrong_phase"|"disabled", latencyMs, model} — every generate
  attempt, success or not (fixes the silently-swallowed AI failure paths)
- `alarm_fired` {roomCode, kind, driftMs} — driftMs = Date.now() −
  scheduled time, for game-deadline alarms
- `client_error` {roomCode?, message, stackHead, url, ua} (from D3)

**LOG HYGIENE (hard rule, unit-tested):** log payloads must NEVER contain:
role assignments per player, seat tokens, host keys, night-action targets,
vote contents, story text/theme, player names. Player IDs and aggregate
counts are fine. Unit test: the `game_started` payload builder (the most
tempting surface) against a real state — assert no roleId appears keyed to
a player and no name/token strings occur; plus a generic assertion helper
used on each payload builder.

## D2 — Metrics (Cloudflare Analytics Engine)

- Orchestrator prerequisite: add `analytics_engine_datasets` binding to
  wrangler.jsonc (`binding: "METRICS"`, dataset `mafia_metrics`),
  regenerate types, confirm pool-workers tolerates it (stub/no-op guard in
  code regardless: `this.env.METRICS?.writeDataPoint(...)` wrapped in
  try/catch — metrics must NEVER throw into a game path or block it).
- Data points (parallel to D1 events): `game_started` (double: playerCount),
  `game_ended` (doubles: day, durationMs), `story_generate` (doubles:
  latencyMs; blob: outcome, model), `msg_timing` (double: ms; blob: type)
  — every message, cheap, this is what perf testing reads, `alarm_drift`
  (double: driftMs), `client_error` (blob: kind), `room_wiped` (blob:
  reason). Index: roomCode.
- Spec appendix: 3 runbook SQL queries (games/week; story_generate p95
  latency + failure-rate by outcome; alarm-drift p95) against the AE SQL
  API — put them in a new docs/RUNBOOK.md section together with `wrangler
  tail mafia-game --format pretty` usage for live debugging.

## D3 — Client error reporting

- Top-level React ErrorBoundary: noir "THE CASE FILE JAMMED" screen with a
  reload button and the room code visible; catches render errors.
- `window.onerror` + `unhandledrejection` listeners (module scope, once).
- All three report via `navigator.sendBeacon` (fallback fetch) to
  `POST /api/client-error`: JSON {message, stackHead (first 4KB), url,
  roomCode (from route if present), ua}. Include a per-page-load cap
  (max 5 reports) client-side.
- Worker endpoint (src/server/index.ts, plain route — NO DO involvement):
  validate size (reject >8KB body), emit `client_error` logEvent + METRICS
  point, return 204. No auth (it's diagnostic), no echo of the body.

## D4 — Lifecycle hardening (from audit part A)

- **Alarm re-arm belt-and-braces:** on WebSocket accept (the /internal/ws
  handshake path), if `room` exists and `ctx.storage.getAlarm()` is null,
  call scheduleNextAlarm — closes the theoretical orphan (claim succeeded,
  alarm scheduling failed, DO never woken again by constructor guard).
  One storage read per socket open — acceptable.
- **Ended-game TTL:** new `ENDED_TTL_MS = 2h` — a room whose game is
  `phase === "ended"` with no live sockets wipes 2h after lastActivityAt
  (between the 1h empty-lobby and 6h absolute paths; absolute 6h stays the
  backstop). `room_wiped` reason "ended_ttl".
- **storyRateLimit:** promote the hardcoded key to a named constant next
  to the other STORY_* keys; delete it in `handleNewGame` (rematch).
- **pendingRuleset surviving into game phase:** deliberate — KEEP (it's
  gated out of snapshots mid-game and preserves the host's counts for the
  rematch lobby). Add a one-line comment saying so.
- **head_sampling_rate:** orchestrator sets it explicitly to `1` in
  wrangler.jsonc with a comment (traffic is tiny; we want every trace).

## Tests

- Unit: log-payload hygiene (D1); logEvent never throws on circular/bad
  fields; client-error size cap.
- Server (pool-workers): ended-TTL wipe at 2h with reason; alarm re-arm on
  socket accept after simulated missing alarm; POST /api/client-error 204
  + oversized 413/400; storyRateLimit key deleted on rematch; story
  generation failure emits `story_generate` with the right outcome (spy on
  console.log); METRICS absent → no throw.
- All existing suites stay green; E2E suite re-run (no new E2E needed —
  ErrorBoundary gets a unit/render test, not a Playwright scenario).

## Non-goals

Distributed tracing spans; third-party APM/Sentry; log retention beyond
Cloudflare's; dashboards (queries in RUNBOOK.md suffice); client analytics
(page views etc.); alerting (future — AE + Cloudflare notifications).
