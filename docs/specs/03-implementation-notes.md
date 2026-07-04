# Spec 03 — implementation notes

Built against baseline `2d5aa11` ("Spec 02: pure-TS game engine — verified").
All suites green (see commands below). Deviations below are one-liners per
the spec's own instruction; anything not listed here matches the spec as
written.

## Deviations

- **D4's spike-first gate was skipped, as the spec itself allowed**: the 16
  existing Spec 01 DO integration tests already prove WS+DO works under
  `vitest-pool-workers`, so the full D4 suite was built directly against
  real WebSockets rather than falling back to direct-stub-call coverage.
- **`ALLOW_TEST_SEED` is not a `wrangler.jsonc` var.** This repo has a single
  `wrangler.jsonc` that also drives `wrangler deploy`, so putting the flag
  there directly would have shipped it to production. Instead: a new
  `.dev.vars` file (wrangler's standard dev-only, never-deployed var file,
  picked up automatically by `wrangler dev` and by `wrangler types`) sets
  `ALLOW_TEST_SEED=1` for local dev, and `vitest.workers.config.ts` passes
  `miniflare: { bindings: { ALLOW_TEST_SEED: "1" } }` to `cloudflareTest()`
  for the pool-workers test project. Verified the compiled `wrangler.json`
  inside `vite build`'s worker output has `"vars":{}` — empty — confirming
  production never sees the flag. `worker-configuration.d.ts` was
  regenerated via `npx wrangler types` to type `Env.ALLOW_TEST_SEED` (it's
  gitignored, machine-generated, not hand-edited).
- **`tsconfig.test-server.json` needed `src/engine` added to its `include`**:
  once `game-room.ts` imports the engine's public entry, TypeScript's
  composite-project mode requires every transitively-imported file to be
  inside some project's `include` list, not just resolvable on disk.
  Mechanical fix, same pattern `tsconfig.server.json` already used.
- **`error` vs `rejection` channel split, since the spec doesn't pin every
  code**: D1 explicitly pins `invalid_ruleset` as an `error` and D4's
  authority test list explicitly groups `start_game` with
  `force_advance`/`mark_absent` under `rejection`. Extending that logic:
  every DO-layer authority/lifecycle-state check on a game command
  (`not_host`, `game_in_progress` on `start_game`, `not_a_player`,
  `no_game`, `not_ended` on `new_game`) went to `rejection` — normal,
  expected-during-play answers, never closing the socket — while
  `invalid_ruleset` (and the pre-existing Spec 01 codes: `bad_message`,
  `not_lobby` on kick/leave, `player_not_found`, etc.) stayed on `error`.
- **A true engine no-op skips persist+broadcast entirely.** `applyCommand`'s
  `timerExpired` branch returns the *same state reference* (not a clone)
  when `at !== state.deadlineAt` — Spec 02 v2.1's staleness guard. Spotted
  this during the stale-alarm test: without special-casing it, the DO would
  still write `GameState` back to storage and fan out an identical snapshot
  to every socket on every spurious/duplicate alarm fire. `applyGameResult`
  now takes the pre-call `GameState` (or `null` for `start_game`, which
  never has a "previous" game) and short-circuits on `result.state ===
  original`, before any storage write. Cheaper and more correct than the
  spec's text implied ("harmless" was read as "no wrong state change", but
  a redundant broadcast is easy to avoid for free).
- **`RoomMeta.phase` (Spec 01's own bookkeeping field, previously always
  `"lobby"`) now mirrors the engine's phase.** Spec 01's join-gate and the
  pre-existing D6 test both key off `room.phase !== "lobby"` as a plain
  string compare (the D6 test even pokes it directly via raw storage
  write). Rather than introduce a second, parallel "is a game running"
  flag, `applyGameResult` sets `meta.phase = result.state.phase` on every
  successful apply, and `handleNewGame` resets it to `"lobby"`. This keeps
  the existing Spec 01 test passing unmodified and satisfies the spec's
  pinned cross-spec invariant ("the composed snapshot phase is the engine
  phase, and Spec 01's lobby gate reads that composed phase") with no new
  storage key.
- **`submitAction`'s `actionType` field is never read by the engine**
  (confirmed by inspection of `machine.ts`'s `submitAction()` — it derives
  the action from the player's role via `activeNightActionFor`/
  `canSubmitMafiaVote`, never `cmd.actionType`). The DO's
  `submit_action` handler therefore only forwards `targetId`, not the
  client-supplied `action.actionType` string — there's nothing for it to
  select.
- **`startGame` is always called without a `roles` argument** (defaults to
  `HOUSE_ROLE_DEFS`). This matches the already-logged v1.1 limitation in
  `STATUS.md` ("applyCommand falls back to the default role registry after
  DO restart — custom-role games need registry re-injection when role packs
  ship") — custom role-pack wiring is Spec 06's job, not this spec's.

## D4 test notes

- The full scripted 5-player game (`test/server/game-room.test.ts`,
  "full scripted game over real WebSockets") uses house rules
  (`mafia:1, villager:2, detective:1, angel:1`), seed `19`, join order
  Alice/Bob/Carol/Dave/Erin — verified directly against `startGame` before
  being pinned, giving angel/villager/detective/villager/mafia in that
  seat order. Script: night 1 mafia kills Dave (unprotected), detective
  investigates the mafia (result lands only in the detective's own
  snapshot), day 1 votes `no_murder` to reach a second night, night 2 the
  angel protects the same player the mafia targets (the scripted "save" —
  attack fails), day 2 unanimous vote eliminates the mafia -> village wins
  the instant mafia count hits zero.
- `drainSnapshots()` always drains all six sockets (five players + host)
  after every command, unconditionally — the DO broadcasts to everyone on
  every apply, so leaving any socket's queue undrained meant a later
  `nextMessageOfType` call could return a stale buffered snapshot instead
  of the latest one (hit this exact bug once: `setUpFivePlayerRoom`'s
  per-join broadcast reaches every already-connected socket, not just the
  host, so all five join events needed draining from every prior joiner
  too).
- Simulating an elapsed timer requires rewriting **both** the DO's own
  `gameDeadlineAt` bookkeeping key **and** the engine's own
  `GameState.deadlineAt` field together — they're normally kept in lockstep
  by `applyEffects`'s `setDeadline` handler, but a test that only rewrites
  one desyncs the alarm's due-check (`gameDeadlineAt`) from what
  `applyCommand`'s `timerExpired` branch validates `at` against
  (`state.deadlineAt`), so the "elapsed" command gets silently rejected as
  stale. Also confirmed empirically: writing an already-elapsed timestamp
  directly via `state.storage.setAlarm()` races Miniflare's own background
  alarm-fire timer nondeterministically (hung/timed-out once, passed once,
  with no code change — pure timing race). The safe pattern, matching the
  pre-existing Spec 01 auth-reap test: leave the real armed-alarm wall-clock
  time wherever it naturally is (a few seconds out) and only rewrite the
  *stored* deadline value(s) that the due-check reads; `runDurableObjectAlarm`
  then forces the still-future alarm to fire on demand, deterministically.

## Commands the orchestrator should run

```
npm run typecheck   # tsc --build --force, all 4 project references
npm test            # vitest: engine (23) + server/DO integration (34)
npm run build       # vite build: worker bundle + client bundle
npm run test:e2e    # playwright: 6 multi-context lobby flows (unchanged, Spec 01's)
```

## Static acceptance checks (all pass)

```
grep -rn "setAlarm" src/server                    # one call site, inside scheduleNextAlarm()
grep -rn "from \"\.\./engine\"" src/server         # game-room.ts only, public entry
grep -r "innerHTML\|dangerouslySetInnerHTML" src/client   # no hits
```

Live gate (per CLAUDE.md verification gates / spec's "Live" acceptance
criterion — orchestrator to run): `npm run dev`, 5 tabs (1 host + 4
players), play one full game with the house ruleset, discard one mafia
member's tab mid-night and confirm seamless resume on reopen.

## Client touch

`src/shared/protocol.ts` grew (new message types, `ClientRoomState.game`,
`serverNow`, `rejection`) — `src/client` needed zero code changes to keep
compiling or to keep its 6 Playwright tests green; the new fields are
additive and the existing lobby UI ignores them. No other `src/client` file
was touched. Full game UI wiring remains Spec 04's job.

## Fix round 1 (2026-07-04) — dawn/dusk strand bug

Orchestrator's live gate caught a real spec-conformance bug: after the
scripted seed-19 game's third night action triggered night resolution,
every snapshot showed `phase: "dawn", deadlineAt: null` and the game
stranded there indefinitely — no alarm ever armed. Spec 02's pin is that
dawn/dusk are "zero-input announcement states" whose beats are "ordinary
setDeadline effects with dawnDuskBeatMs as the interval" — they must
auto-advance without host action. This spec's own D4 tests all passed
anyway because every dawn/dusk transition in them was driven by a host
`force_advance` (which always carried `now`), never by the player action
that naturally completes a phase — so the coverage gap matched the bug
exactly.

**Root cause**: `src/engine/machine.ts`'s `effectsForDeadline(state, now)`
silently skips arming a deadline when `now === undefined`. `submitAction`,
`castVote`, `retractVote`, and the `markAbsent`/`markPresent` branch in
`applyCommand` all called `advanceIfComplete(state, [])` with no `now` —
only `forceAdvance` and `timerExpired` ever carried one. So a player's own
action completing a night or a vote transitioned the phase but never armed
the next beat's timer; only a host force-advance (which nothing in ordinary
untimed house-rules play ever triggers) happened to work.

**Fix** (both layers, as prescribed):
1. `src/engine/types.ts`: added optional `now?: number` to `submitAction`,
   `castVote`, `retractVote`, `markAbsent`, `markPresent` (the two commands
   that already had it, `forceAdvance`/`timerExpired`, are unchanged).
2. `src/engine/machine.ts`: threaded `cmd.now`/`now` through every call site
   that can trigger a transition — the `markAbsent`/`markPresent` branch in
   `applyCommand`, both `advanceIfComplete` calls inside `submitAction`
   (mafia-consensus and individual-action paths), and `castVote` (which
   gained a `now` parameter, passed from `applyCommand`). `retractVote`
   needed no change — it never transitions phases, only removes a vote.
3. `src/server/game-room.ts`: every game-command builder in
   `webSocketMessage`'s switch (`submit_action`, `cast_vote`,
   `retract_vote`, `mark_absent`, `mark_present`) now sets `now: Date.now()`
   — `force_advance` already did. The engine stays pure; the clock is still
   injected from the one place that's allowed to call it.

**Regression tests added**:
- `test/engine/engine.test.ts`: "player-triggered phase completions (no
  forceAdvance) still arm the next beat's deadline" — drives a full
  night-to-dawn and day-to-dusk transition purely through player
  `submitAction`/`castVote` calls (no `forceAdvance` anywhere in the test)
  and asserts both the returned effects and `state.deadlineAt` are set to
  `now + dawnDuskBeatMs`. Sits right next to the pre-existing "dawn and dusk
  beats emit setDeadline effects" test, which only ever exercised
  `forceAdvance` — that gap is exactly why this shipped in fix round 0.
- `test/server/game-room.test.ts`: new test "a player's own action
  completing the night arms the dawn beat's alarm, no force_advance
  needed" in the `timer path and stale-alarm no-op` suite — drives a real
  5-player game's night 1 to completion over WebSockets with zero
  `force_advance` messages, confirms `gameDeadlineAt` is armed in storage,
  then fires the real unified alarm (`runDurableObjectAlarm`) and confirms
  dawn -> day happens with no host intervention at all.
- The existing full scripted-game test was updated to advance dawn/dusk via
  the real alarm (`advanceViaAlarm` helper — moves the stored deadline into
  the past, both the DO's `gameDeadlineAt` key and the engine's own
  `GameState.deadlineAt` together, then forces the still-future real alarm
  early via `runDurableObjectAlarm`) for night 1's dawn beat and day 1's
  dusk beat — the spec-true unattended path. Kept exactly one
  `force_advance` (night 2's dawn beat) as the deliberate host-impatience
  case: forcing past an already-correctly-armed deadline is still a valid
  host shortcut, distinct from the old bug where force_advance was the
  *only* way to ever get unstuck.

**Verification**: `npm run typecheck` clean; `npm test` — engine 24/24
(23 + 1 new), server 35/35 (34 + 1 new); `npm run build` succeeds;
`npx playwright test` 6/6 unchanged. No new dependencies, no commits.

STATUS: fix-round-1 complete, suites green
