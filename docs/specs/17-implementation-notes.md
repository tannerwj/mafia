# Spec 17 implementation notes — ops: observability + lifecycle hardening

Built against HEAD `050ff2e` (verified via `git log --oneline -1` before
starting; tree was clean). No worktree isolation used — worked directly in
the repo per the brief.

## Files changed / added

- `src/server/log.ts` (new) — `logEvent(event, fields)`: one
  `console.log(JSON.stringify({evt, ...fields}))` line, never throws (double
  try/catch fallback for circular refs / BigInt / other unserializable
  fields), never awaited.
- `src/server/log-events.ts` (new) — `tallyRoleCounts` (aggregate-only
  roleId tally from `GameState.players` post-`startGame`, never keyed to a
  player) and `assertLogHygiene` (recursive forbidden-key walker used by
  `test/server/log.test.ts` against every payload shape D1 lists).
- `src/server/metrics.ts` (new) — `writeMetric(env, point)`:
  `env.METRICS?.writeDataPoint(...)` wrapped in try/catch, builds the AE data
  point conditionally (see "exactOptionalPropertyTypes" deviation below).
- `src/server/game-room.ts` — wired every D1 event + D2 metric + all of D4.
  See per-item notes below.
- `src/server/index.ts` — added `POST /api/client-error` (D3), plain route,
  no DO involvement, before the `/api/rooms` POST handler. Did not touch
  Spec 16's `/room/*` HTMLRewriter interception or assets fallback.
- `src/client/net/errorReporting.ts` (new) — `ErrorReporter` (plain class:
  per-page-load cap of 5, sendBeacon-then-fetch-fallback, 4KB stack-head
  truncation, never throws), `installGlobalErrorHandlers` (wires
  `window.onerror`/`unhandledrejection`), `getSharedReporter` (module-scope
  singleton — see deviation below), `roomCodeFromPathname`,
  `truncateStackHead`. Same jsdom-less plain-class-plus-hand-rolled-globals
  pattern as `WakeLockManager`/`RoomConnection`.
- `src/client/components/ErrorBoundary.tsx` (new) — class component,
  "THE CASE FILE JAMMED" noir fallback with reload button + room code (if
  present), reports via `getSharedReporter().report("boundary", ...)` from
  `componentDidCatch`.
- `src/client/main.tsx` — installs global handlers once at module scope,
  mounts `<ErrorBoundary>` at the app root (wraps `<App />`).
- `docs/RUNBOOK.md` (new) — event list, metrics dataset layout (including
  the blob-discriminator convention, a deviation — see below), 3 SQL
  queries (games/week, story_generate p95+failure-rate, alarm-drift p95),
  `wrangler tail` usage, two diagnosis playbooks.
- Tests: `test/server/log.test.ts` (new), `test/client/errorReporting.test.ts`
  (new), `test/server/game-room.test.ts` (D4/D1/D3 additions, see below).

## D1 — structured logging

All 12 spec-listed events emit exactly as pinned: `room_claimed`,
`game_started`, `game_ended`, `room_wiped`, `ws_open`, `ws_close`,
`ws_error`, `auth_rejected`, `msg_slow`, `story_generate`, `alarm_fired`,
`client_error`.

Notable implementation choices (not deviations from the spec's field list,
but decisions the spec left open):

- **`ws_open`'s `authKind` fires at `hello`-completion time**, not
  WebSocket-accept time, using `msg.auth.kind` (`host`/`seat`/`join`) — at
  accept time identity isn't known yet. `ws_close`/`ws_error` read the
  socket's attachment kind at close time (`host`/`player`, or `pending` if
  the socket never completed auth).
- **`game_ended`'s `durationMs`** needed a "when did this game start"
  timestamp that doesn't exist anywhere in `GameState`/`RoomMeta` — added a
  new storage key `GAME_STARTED_AT_KEY` (`"gameStartedAt"`), written in
  `handleStartGame` alongside the game state, read (and deleted on rematch)
  in `applyEffects`'s `gameEnded` branch. This is additive-only new storage,
  not a protocol/spec-pinned field change.
- **`game_ended`'s `reason`** comes from the engine's own `state.log`
  (`{type: "gameEnded", winners, reason}`, pushed by `machine.ts` in the same
  turn) rather than the `Effect` type (which only carries `winners`) — found
  via the most recent matching log entry.
- **`story_generate` outcome classification**: `runStoryGeneration`'s return
  type changed from `output | null` to `{outcome, output}` so the caller can
  distinguish `timeout`/`parse_fail`/`model_error` (previously all collapsed
  to `null`/`"generation_failed"`). The `not_host` rejection path in
  `handleGenerateStory` does NOT log `story_generate` — it's an authority
  rejection on the command envelope itself (mirrors `sendRejection` elsewhere
  in the file), never touches story state, and isn't one of the spec's nine
  outcome values.

## THE LOG HYGIENE HARD RULE

`assertLogHygiene` (`src/server/log-events.ts`) is a generic, recursive
forbidden-key walker (not a per-event hardcoded check) so any future new
event's payload builder is automatically covered by the same test. Forbidden
keys: `seatToken(s)`, `hostKey(s)`, `targetId`, `target`, `voteContents`,
`votes`, `storyText`, `theme`, `scene`, `text`, `name(s)`, `playerName`.
`tallyRoleCounts` is unit-tested to confirm its output is aggregate-only
(`{roleId: count}`, never player-keyed). `test/server/log.test.ts` covers
both, plus a nested-object/nested-array case (a forbidden key inside
`roleAssignments: [{playerId, name}]`, matching the spec's called-out
"most tempting surface").

## D2 — metrics

`writeMetric` is called at every D1 event's log site with the spec's
pinned doubles/blobs/index shape, EXCEPT for one deviation:

**Deviation: metric-name discriminator blob.** The spec's data-point table
doesn't include an event-name field, but every point lands in the same flat
`mafia_metrics` table — without a discriminator, a query can't reliably tell
a `game_started` point's `double1=playerCount` apart from an unrelated
point's `double1`. Added the convention that **`blobs[0]` is always the
metric name** (`"game_started"`, `"game_ended"`, `"story_generate"`,
`"msg_timing"`, `"alarm_drift"`, `"client_error"`, `"room_wiped"`), with any
event-specific blobs (outcome, model, message type, wipe reason) following
it. Documented in `docs/RUNBOOK.md`'s metrics table; all three example SQL
queries filter on `blob1`.

`writeMetric` is a true no-op (never calls `writeDataPoint`, never throws)
when `env.METRICS` is absent — unit-tested directly in
`test/server/log.test.ts` by constructing an `env` object without the key.
Note: **inside the pool-workers test environment, `env.METRICS` is actually
a real (local) `AnalyticsEngineDataset`** (pool-workers reuses
`wrangler.jsonc`, which has the binding) — the "absence" contract can only
be tested at the plain-unit level, not as a pool-workers integration test.
`test/server/game-room.test.ts` has a corresponding test that instead proves
the OTHER half: a live local binding doesn't derail a full connect/ping
lifecycle.

`exactOptionalPropertyTypes` (already on in this repo's `tsconfig.json`)
rejected `{indexes: string[] | undefined}`-shaped objects being passed to
`AnalyticsEngineDataPoint`/`MetricPoint`. Fixed by building the data point
conditionally (only assigning keys that are actually set) in `writeMetric`
and at the two call sites (`index.ts`'s client-error handler,
`errorReporting.ts`'s `report()`) that had the same shape — omission instead
of explicit `undefined`, no behavior change.

## D3 — client error reporting

- `ErrorReporter` shared as a **module-scope singleton**
  (`getSharedReporter()`) between `main.tsx`'s global-handler installation
  and `ErrorBoundary`'s `componentDidCatch` — necessary so the spec's
  "max 5 reports per page load" cap is enforced across BOTH report sources,
  not double-counted by two independent `ErrorReporter` instances (the
  initial draft had two separate instances; caught and fixed before writing
  tests).
- Added a `kind` field (`"boundary"|"onerror"|"unhandledrejection"`) to the
  client's `POST /api/client-error` body. The spec's D3 payload shape
  (`{message, stackHead, url, roomCode, ua}`) doesn't list one, but D2
  explicitly asks for a `client_error` metric with `blob: kind` — there's no
  other field D2 could mean by "kind" than which of the three report sources
  fired. Server defaults to `"unknown"` for a malformed/older payload rather
  than rejecting the whole report over a missing classifier.
- Server validation: reject `>8KB` via `content-length` header (fast path)
  AND actual body length (in case the header lies/is absent) → 413;
  malformed JSON → 400; missing/non-string `message` → 400; otherwise 204,
  body never echoed.
- `ErrorBoundary` itself is intentionally NOT render-tested — this client
  test project has no jsdom/testing-library (confirmed: not in
  `package.json` devDependencies), matching the existing
  `WakeLockManager`/`useWakeLock` split noted in that file's own header. All
  the actual logic (cap, truncation, beacon/fetch fallback, global handler
  wiring, room-code parsing) lives in `errorReporting.ts` and is fully unit
  tested (23 tests); the boundary component itself is a thin ~15-line
  `componentDidCatch` + fallback JSX with nothing left to test in isolation
  without a DOM.

## D4 — lifecycle hardening

- **Alarm re-arm on WS accept**: `scheduleNextAlarm()` was already called
  unconditionally after every `/internal/ws` accept (pre-existing code) —
  since it's idempotent, this call site already double-served as the
  belt-and-braces re-arm the spec describes; added a comment explaining that
  rather than a redundant conditional `getAlarm()` check + duplicate call
  (an earlier draft had both; simplified once I confirmed the existing call
  already satisfies the invariant). Test: deletes the alarm out-of-band via
  `runInDurableObject`, opens a socket, confirms `getAlarm()` is non-null
  afterward — without a full DO eviction (unlike the existing
  "wake-recovery constructor guard" tests), isolating this specifically to
  the accept-path re-arm rather than the constructor guard.
- **`ENDED_TTL_MS = 2h`**: new constant next to `EMPTY_LOBBY_TTL_MS`/
  `ABSOLUTE_TTL_MS`. Alarm's wipe-eligibility check now computes
  `shouldWipeEndedTtl = room.phase === "ended" && idleMs >= ENDED_TTL_MS`
  alongside the existing two conditions, and the `room_wiped` reason is
  picked by priority (`empty_lobby` > `ended_ttl` > `absolute_ttl` — the
  three are mutually exclusive in practice by phase, but empty_lobby is
  checked first defensively). Tests: wipes at +2h in `"ended"` phase; does
  NOT wipe an ended game before 2h; does NOT apply to a `"lobby"`-phase room
  even past the 2h mark (isolates ended_ttl from leaking into other phases).
- **`storyRateLimit` → `STORY_RATE_LIMIT_KEY`**: promoted to a named
  constant next to `STORY_INFLIGHT_KEY`/`STORY_STATE_KEY`, replacing three
  separate hardcoded `"storyRateLimit"` string literals
  (`isStoryRateLimited`, `recordStoryGeneration`, and the new deletion
  call). Deleted in `handleNewGame` per the spec's explicit instruction — a
  rematch gets a fresh 10/min budget rather than inheriting usage from the
  previous game. (I initially reasoned this should be a per-ROOM limit that
  persists across rematches to prevent abuse, but the spec is explicit
  ("delete it in `handleNewGame`"), so implemented as specified — flagging
  the tension in case it's revisited: a host could currently exhaust the
  limit, call `new_game`, and get a fresh budget without actually starting a
  new game session's worth of real playtime.)
- **`pendingRuleset` comment**: added at the `buildStateFor` gate site
  (`game ? null : ...`) explaining the survive-into-game-phase behavior is
  deliberate (preserves host's role-count choice for the rematch lobby), per
  spec.
- **`GAME_STARTED_AT_KEY` cleanup on rematch**: also deleted in
  `handleNewGame` (not spec-listed, but load-bearing for `durationMs`
  correctness — see D1 notes above; without it a rematch's `game_ended`
  would report a duration measured from the PREVIOUS game's start).

## msg_slow / msg_timing wrapper

`webSocketMessage` (the DO's public override) is now a thin timing shell:
renamed the original method body to `handleMessage` (private), and the
public `webSocketMessage` wraps it with `Date.now()` before/after, a
best-effort `peekMessageType` (re-parses just `{type}` for the metric label
— never used for actual dispatch, which still happens inside
`handleMessage`'s own re-parse; if peek fails, labeled `"unknown"`), logs
`msg_slow` only when >50ms, and always emits the `msg_timing` metric
(cheap, one data point per message). One extra `RoomMeta` storage read per
message for the room code in the `finally` block — acceptable per the
spec's own precedent (D4's alarm re-arm accepts the same one-read-per-event
cost).

## Tests

- `test/server/log.test.ts` (new) — 22 tests: `logEvent` shape/never-throws
  (circular ref, BigInt, default empty fields), `tallyRoleCounts` aggregation,
  `assertLogHygiene` clean-payload-passes + forbidden-key-detection (flat,
  nested-object, nested-array) + no-false-positive-on-substring, `writeMetric`
  absence-no-op + inner-throw-swallowed + field-omission-shape.
- `test/client/errorReporting.test.ts` (new) — 23 tests: `roomCodeFromPathname`,
  `truncateStackHead`, `ErrorReporter` (beacon success/fallback-to-fetch/
  both-unavailable, roomCode omission, 5-report cap, stack truncation,
  never-throws-even-if-transport-throws), `installGlobalErrorHandlers`
  (onerror with room code, unhandledrejection with Error and non-Error
  reasons, teardown).
- `test/server/game-room.test.ts` additions — 14 tests across 6 new
  `describe` blocks: ended-TTL wipe (+2h, not-before-2h, doesn't-leak-into-
  lobby-phase), alarm re-arm on accept, storyRateLimit deletion on rematch,
  story_generate outcome logging (disabled path + ok/faked-success path, both
  asserted via `console.log` spy + JSON parse of the emitted line), METRICS
  live-binding lifecycle sanity, and 5 `/api/client-error` tests (accept+204,
  logs client_error, oversized→413, malformed JSON→400, missing message→400).

All existing suites (engine, client, server) remain green — nothing in this
spec touched engine internals or existing protocol fields.

## Fresh counts (this session)

- `npm run typecheck` — clean.
- `npm test` (engine + client + server, `dist/client` already present from a
  prior build, so no extra `vite build` step was needed) — **358/358 pass**
  across 12 test files (engine 175, client 54, server 129). Zero failures,
  zero skips. The `close timed out after 10000ms` / `EnvironmentTeardownError`
  messages after the server project's run are the same known
  `vitest-pool-workers` teardown quirk called out in Spec 16's notes
  (pre-existing, unrelated to this spec's changes, occurs after tests report
  as passed).
- Playwright / `wrangler dev`: not run (out of scope for implementer — no
  new E2E scenarios are needed per the spec's own "Tests" section: "no new
  E2E needed — ErrorBoundary gets a unit/render test, not a Playwright
  scenario").

## Non-deviations worth noting

- Did not touch `src/server/storyteller.ts` — all outcome classification
  happens in `game-room.ts` where the AI call site already lives, per the
  brief's own preference ("prefer classifying in game-room.ts").
- Did not disturb Spec 16's `/room/*` HTMLRewriter interception or assets
  fallback in `index.ts` — the new `/api/client-error` route sits entirely
  within the existing `/api/*` handling region, before `/api/rooms`.
- `head_sampling_rate: 1` and the `METRICS` binding were already present in
  `wrangler.jsonc` (orchestrator prerequisite, confirmed done before I
  started) — no config changes made in this session.

STATUS: COMPLETE
