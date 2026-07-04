# Spec 03 — DO ⇄ engine integration

**v2.2 — 2026-07-04 · Status: approved for build**
*v2.1 (Spec 04 review fallout): `start_game` gains an env-gated `seed?`
field — this spec's own D4 scripted game needed it too. v2.2 (Spec 05
review fallout): `force_advance {gen}` double-fire guard; `serverNow` in
every snapshot for client clock-offset correction.*
*v2 folds in all findings from Codex adversarial review (2026-07-04): alarm
payload reconstruction from storage, due-time staleness model + engine
`deadlineAt` validation (Spec 02 amended to v2.1), constructor alarm
recovery, fresh-read scheduler pin, D4 spike-first gate for the pool-workers
WebSocket limitation, rejection message declared as a Spec 01 protocol
amendment, cross-spec lobby-gate invariant, abandoned-room tradeoff stated,
player-order and players-merge pins. No findings overruled.*
Parent: PLAN.md §Architecture. Depends on: Spec 01 (identity/rooms), Spec 02
(engine). Read both fully first — this spec only bridges them.

## Goal

A complete, playable-over-raw-WebSockets game server: the host starts a game
from the lobby with a validated ruleset; commands flow socket → DO → engine;
every applied command persists state and re-broadcasts personalized
snapshots; engine deadlines ride the Spec 01 unified alarm scheduler; a
phone that vanishes mid-night reconnects into exactly its seat and view.
Done looks like: a pool-workers test drives a full 5-player game (night
kill, investigation, protection, day vote, win) over WebSockets, including a
hibernation eviction mid-night, with zero UI.

## Non-goals

Any UI beyond what Spec 01 D5 shipped (Spec 04). Host console UI (Spec 05).
Ruleset *editor* (Spec 06 — this spec accepts a `Ruleset` object as-is).
Playwright full-game E2E (arrives with Spec 04's UI; this spec's E2E surface
is pool-workers over raw sockets).

## Pinned conventions

- **The engine API is the only game interface**: `startGame`, `applyCommand`,
  `projectFor`, `validateRuleset`. The DO never reads or writes `GameState`
  internals — it persists the object opaquely and projects through
  `projectFor`. Any DO code switching on game phase (beyond `=== undefined` /
  `ended`) is a spec violation.
- **Apply-persist-broadcast, in that order, atomically per message**: engine
  call → `ctx.storage.put('game', state)` + any deadline bookkeeping in the
  same storage transaction → broadcast projections → THEN handle effects that
  schedule alarms (`scheduleNextAlarm()`). No `await` between engine apply
  and storage put. Broadcast failures to individual sockets are ignored
  (Spec 01 reconnect handles them).
- **Alarm firing model** (Cloudflare's `alarm()` callback carries NO
  payload — only `{retryCount, isRetry}`; everything else is reconstructed
  from storage at fire time):
  1. Handler reads ALL deadline inputs **fresh from storage** (never values
     cached earlier in any turn — pinned for `scheduleNextAlarm()` too).
  2. For the game deadline: if `gameDeadlineAt` is absent or `now <
     gameDeadlineAt`, it is not due — skip (re-arm at step 4). If due, apply
     `{timerExpired, at: gameDeadlineAt}`.
  3. The engine validates `at === state.deadlineAt` (Spec 02 v2.1) and
     no-ops otherwise — so a stale alarm armed for a deadline that
     force-advance already consumed is harmless at BOTH layers: the DO only
     fires what is currently due, and the engine only accepts what it
     currently expects. At-least-once delivery, exactly-once effect.
  4. Handler finishes by calling `scheduleNextAlarm()` — the alarm is a
     scheduler tick (Spec 01), so a non-game deadline firing first never
     loses `gameDeadlineAt`, and vice versa.
- **Deadline multiplexing**: the engine's `setDeadline(at)` effect stores
  `gameDeadlineAt` in DO storage; `scheduleNextAlarm()` (Spec 01) takes
  `min(authReap…, emptyLobby?, absoluteTtl, gameDeadlineAt?)`. `clearDeadline`
  removes it. One alarm slot, one scheduler — no second call site (Spec 01
  acceptance criterion 4 still holds).
- **Wake recovery (crash window)**: persisting deadline inputs and arming
  the alarm happen in different turns, so a crash can leave a durable
  `gameDeadlineAt` (or `pendingAuth` entry) with no armed alarm. Pin: on DO
  construction, `if (await ctx.storage.getAlarm() === null)` and any
  deadline-contributing key exists → `scheduleNextAlarm()` immediately.
  (Orchestrator note: verify the Spec 01 implementation has this guard too;
  if not, it lands here as scheduler hardening.)
- **Presence ≠ absence**: disconnection never auto-marks a player absent
  (phones sleep constantly — that's normal, not abandonment). Only the host
  issues `markAbsent`/`markPresent`. Presence booleans (from Spec 01 socket
  accounting) are carried in every snapshot so the host can *see* who's
  disconnected and decide.
- **Snapshot composition**: `ClientRoomState` gains
  `game: ClientGameView | null` (null in lobby) and `phase` becomes the
  engine phase once a game exists. Each connection's snapshot uses its
  identity: player sockets → `projectFor(state, {kind:'player', id})`, host
  sockets → `{kind:'host'}`. Seat-token rejoin mid-game gets `welcome` with
  the same personalized view (this is the product's core promise — test it).
- **`lastActivityAt`** (Spec 01) updates on every accepted game command
  (still never on `ping`).
- **Game lifecycle**: `startGame {ruleset}` — host-only, lobby-only, player
  count ≥ 3 (engine validates the rest via `validateRuleset`; errors return
  `error{invalid_ruleset, detail}` to the host, room stays in lobby).
  Cross-spec invariant (pinned): once `start_game` applies, the composed
  snapshot `phase` is the engine phase, and Spec 01's lobby gate reads that
  composed phase — so no `join` can land in a started game; it gets
  `game_in_progress` (seat-token rejoin unaffected). The DO's
  single-threaded turns make this airtight; state it, don't infer it.
  `newGame {}` — host-only, **only when engine phase is `ended`** (no
  mid-game abandonment in v1; the host force-advances to finish a dead game
  instead — deliberate: mid-game reset is a rage-quit footgun at a party).
  `newGame` deletes the `game` key, keeps all seats/tokens, returns to
  lobby, broadcasts. Players who joined the room while a game was running
  (rejected by Spec 01's lobby gate) simply join now.
- **Kicks during a game**: refused (`error{game_in_progress}`) — the host
  uses `markAbsent` instead; seats are never destroyed mid-game (a kicked
  seat would corrupt role/parity math). Kick works again once `ended`.
- **Abandoned-room tradeoff (accepted, stated)**: a mid-game room with the
  host gone forever, an untimed ruleset, and idle players has no exit
  faster than Spec 01's 6h TTL. Deliberate: this is a host-attended party
  product, and auto-destroying a game that humans might resume is worse
  than a stale room. `validateRuleset` emits a *warning* (not error) when
  all phase timers are absent.

## Deliverables

**D1 — protocol extensions** (`src/shared/protocol.ts`): client→server
`start_game {ruleset, seed?}` — `seed` honored ONLY when the Worker env has
`ALLOW_TEST_SEED="1"` (set in wrangler.jsonc dev vars and the pool-workers
test config; never in production deploy config — silently ignored
otherwise). With a fixed seed and deterministic join order, tests know the
full role assignment; production seeds come from `crypto.getRandomValues`.
Also: `submit_action {action}`, `cast_vote {target}`,
`retract_vote {}`, `force_advance {gen}` (echoes `phaseGen` from the
sender's latest snapshot — Spec 02 v2.3 no-ops stale ones with a
`stale_advance` rejection), `mark_absent {playerId}`,
`mark_present {playerId}`, `new_game {}`. Every snapshot/welcome payload
includes `serverNow: number` (epoch ms at send time) — clients compute a
clock offset once per connection and render countdowns against corrected
time (skewed phone clocks are common; ±2s render tolerance is jitter
allowance, not skew handling). Server→client: snapshot carries
the composed state (see conventions); `rejection {code}` for engine-rejected
commands (distinct from `error` — a rejection is a normal game answer, e.g.
`not_your_phase`, and never closes the socket).
**This formally amends Spec 01 D1/D4**: the server→client union gains
`rejection`, and `RoomConnection` must expose a `rejection` event distinct
from `error` (no close-code or reconnect behavior attaches to it).
**Snapshot merge rule**: `ClientRoomState.players` stays the single source
for identity/`connected`/`isYou` for the room's whole life; `ClientGameView`
never carries its own players array — it references players by `id` only
(alive flags, votes, roles live game-side; name/connected live room-side;
the client joins them). **Player order is join order, always** — snapshots
never reorder by alive/role status (reordering leaks information).

**D2 — `GameRoom` integration** (`src/server/game-room.ts`): command
routing (socket identity → engine `playerId`; host-only commands asserted
against attachment kind — never client payload), apply-persist-broadcast
pipeline, effect handling (`setDeadline`/`clearDeadline` → storage +
`scheduleNextAlarm()`; `gameEnded` → log + broadcast; engine `rejection` →
`rejection` message to the issuing socket only), alarm branch: when the
unified alarm fires a due `gameDeadlineAt`, apply `{timerExpired, at}`.

**D3 — storage schema**: `game` (opaque engine state), `gameDeadlineAt`
(number, absent when none). Spec 01 keys unchanged.

**D4 — tests** (pool-workers, driving real WebSockets against the DO):
**Spike first, as a go/no-go gate before D1–D3**: Cloudflare's known-issues
doc states WebSockets + Durable Objects are unsupported under per-file
storage isolation — the server test project likely needs
`singleWorker`/no-isolate config (a Spec 00 vitest config change; note it in
implementation notes). Also unproven: `SELF.fetch()` WS upgrade returning a
usable `response.webSocket`, and client-side socket usability after
`evictDurableObject()` (historical crash class in exactly this
intersection — workers-sdk#5439). Build ONE minimal test proving
connect → message → evict → message first. Fallback if the platform says no:
hibernation coverage via direct DO-stub calls (no client socket), and the
full-game-over-real-sockets scenario moves to Playwright in Spec 04 —
report which path was taken.
Then:
- Full 5-player scripted game: host starts (house rules, no timers), mafia
  consensus kill, angel save on night 2, detective result arrives in
  detective's snapshot only, day vote with runoff, village win. Assert
  final log + winner.
- Mid-game hibernation: `evictDurableObject` during night → sockets survive,
  next command applies, state intact (roles unchanged, pending actions
  preserved).
- Mid-game rejoin: close a player's socket during night, re-`hello` with
  seat token → welcome carries their role + pending-action state.
- Timer path: start with a short night timer → `runDurableObjectAlarm` →
  phase advanced with defaults applied; stale-alarm no-op (force-advance
  first, then fire the old alarm → state unchanged).
- Authority: non-host `start_game`/`force_advance`/`mark_absent` →
  `rejection`; host-spoofed payload ignored (identity from attachment).
- Lifecycle: `new_game` refused mid-game; accepted at `ended`; seats
  retained; lobby joins work after.
- Kick refused mid-game; presence flags in snapshots flip on disconnect.
- Projection privacy over the wire: capture every frame sent to a living
  villager's socket for a whole scripted game → no other living player's
  role string ever appears; dead player's mid-night frames contain no
  pending submissions; host's do.
- Player array order is join order in every frame across the whole game
  (never reordered by death/role — reordering is an information leak).
- Wake recovery: persist a `gameDeadlineAt`, delete the alarm
  (simulate the crash window), reconstruct the DO → constructor guard
  re-arms; `runDurableObjectAlarm` then advances the phase.

## Acceptance criteria

CI-verifiable:
1. D4 suite green; `npm run typecheck` clean; Spec 01 + engine suites still
   green (no regressions).
2. `grep -rn "setAlarm" src/server` → only inside `scheduleNextAlarm()`.
3. `grep -rn "import.*engine" src/server` → imports only from the engine's
   public entry (`src/engine/index.ts`).

Live (orchestrator): `vite dev` + a scripted multi-tab session (Chrome
DevTools): 5 tabs (1 host + 4 players), play one full game with the house
ruleset — phone-lock simulation (tab discard) on one mafia member mid-night,
confirm seamless resume.

## Notes for implementer

- Zero new dependencies.
- Read `docs/specs/01-implementation-notes.md` and
  `docs/specs/02-implementation-notes.md` first; build on what's there, not
  around it.
- The Spec 01 alarm scheduler is already the single owner of `setAlarm` —
  extend its deadline inputs; do not add a parallel path.
- Deviations → `docs/specs/03-implementation-notes.md`.
- Report: what's built, decisions, exact commands for orchestrator verify.
