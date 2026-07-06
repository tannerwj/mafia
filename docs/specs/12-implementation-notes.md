# Spec 12 — implementation notes

Built against commit `ffa87aa` (Spec 12 v2). Three features on the live game:
narrator vote/status board (host-only), optional sunrise/sunset narrator-gated
reveal beats (deferred resolution), and an all-player game-status panel.

## Feature 2 — sunrise/sunset (deferred resolution)

The leak-proof design from v2: when `ruleset.scenePhases` is on, a NATURAL
readiness advance defers resolution.

- `advancePhase` (src/engine/machine.ts): `night` + scenePhases + NOT forced →
  `transition(state, "sunrise")` with NO `resolveNight` (night stays UNRESOLVED
  — nothing computed, nothing can leak). Symmetric for `day`/`runoff` →
  `sunset`. A FORCED advance (host force-advance / `timerExpired`) is the host's
  escape hatch and resolves DIRECTLY to dawn/dusk, bypassing the scene beat
  (host-only, no leak concern).
- `sunrise`/`sunset` arms NO deadline (`timerMs` returns null for them) — they
  wait for the host's `reveal`. `advanceIfComplete` has no arm for them, so no
  player command auto-advances out of a scene phase.
- `reveal` command (`revealScene`): resolves NON-forced. sunrise/sunset are only
  ever reached via the natural readiness gate, which already required consensus
  convergence (night) / all-locked votes (day), so a non-forced resolution
  reproduces exactly the outcome the narrator saw from the locked inputs.
- `reveal` contract: host-only (`not_host`); legal ONLY in sunrise/sunset
  (`reveal_not_active`, phase-gated BEFORE the gen guard so it never masquerades
  as `stale_advance`); rejects LOUDLY `stale_advance` on gen mismatch (like
  forceAdvance — a single trusted actor whose UI disables the button, NOT the
  silent no-op `acknowledge` uses). Host force-advance also works.

Phase-discriminant audit (all explicit arms added, no fallthrough):
- `GameScreen.tsx` `tintFor`: converted to an exhaustive switch; sunrise→night
  tint, sunset→day tint.
- `GameScreen.tsx` render chain: added `sunrise`/`sunset` → `SceneHolding`
  BEFORE the `isDead` branch (during a scene phase the would-be-dead player is
  still projected alive and must see the neutral holding screen, not a god view
  that would leak the pending outcome).
- `hostView.ts` `phaseLabel` (exhaustive switch): added Sunrise/Sunset.
- `hostView.ts` `forceAdvanceCopy` (exhaustive switch): added sunrise/sunset
  copy.
- `hostView.ts` `phaseSummary` (if-chain): added sunrise/sunset summaries.
- `timerMs` (machine.ts): unchanged — its final ternary already yields null for
  any phase not in {night,day,runoff,dawn,dusk}, which is correct (scene phases
  have no timer).

## Feature 1 — narrator board (host-only)

- History RECONSTRUCTED from log-event replay, NOT retained raw state and NOT a
  new projection variant: `narratorBoardHistory(log)` in project.ts (exported
  via the engine index). It keys off `actionLocked`/`voteLocked` events (so
  "locked only" falls out for free) and recovers targets by pairing each lock
  with that actor's most-recent preceding `actionSubmitted`/`voteCast` for the
  same day (engine invariant: re-submitting clears the lock, so the locked pick
  is always the last-submitted one). Last-locked-wins; unlock removes the row.
- HOST-ONLY by contract: the helper reads `actionSubmitted` TARGETS, which
  `resolvedLog` strips from every non-host log — so a non-host caller literally
  cannot reconstruct night targets from their own projection (verified in a unit
  test: a player's log yields night rows with `targetId: null` only, because
  `actionLocked` — who-locked, no target — does reach players but carries no
  target). `NarratorBoard.tsx` lives under `screens/host/**`, imported only by
  the host console.
- Current-phase stragglers ("who hasn't locked") come from the live host
  projection: `players[].acted === false` at night (host-only field), living
  players without a locked vote by day.
- Per-day nav (`board-phase-nav`), follows the current day forward, host free to
  browse back into history.

## Feature 3 — all-player game status

- `projectFor` now emits, for EVERY viewer: `rolesRemaining` ({roleId, count}
  AGGREGATES ONLY — grouped and counted, never a per-living-player array),
  `graveyard` (one entry per dead player, role per `revealOnDeath`, reusing the
  `revealForPublic` disclosure rule), `headcount` ({alive, total}).
- Full counts always, regardless of `revealOnDeath` (Tanner's transparency
  choice, 2026-07-05). Accepted tradeoffs stated in the spec (§Feature 3): full
  counts reveal the exact alive breakdown under a hidden setup, and a death's
  timing can retroactively correlate to a count change — both accepted.
- `GameStatus.tsx` ("The Case So Far"): a read-only Dialog any player (living or
  dead) can open anytime via `game-status-button`, shown for every in-game
  player screen except the end splash. Renders only the aggregate fields — never
  a per-living-player role row (E2E asserts the panel HTML names no living
  player at all).

## Player day-view (verify-only + pinned CURRENT-PHASE-ONLY)

DayVoting is unchanged: it renders only `state.votes` for the active day/runoff
per `votingVisibility` (hidden = sealed, realtime = live), never history, never
night role voting. The host board's history plumbing (`narratorBoardHistory`)
is NOT reused on any player path — it lives in the host-only component. Detective
history is already a full accumulated list (`you.investigationResults`, filtered
per viewer, never cleared) — confirmed, no change.

## Leak-test results

- Holding screen carries no outcome: unit + server + E2E all assert that during
  sunrise the victim still shows `alive`, no `playerDied`/`attackAttempted` in
  any player log, and no `watch`/action detail; the player-facing SceneHolding
  reads nothing from `game` beyond the phase.
- Game-status aggregate-only: unit + server assert `rolesRemaining` entries have
  no `playerId`, sum to the living count, and reach every viewer; the E2E
  asserts the rendered panel names no living player.
- Player never gets night voting: DayVoting unchanged (current-phase day votes
  only); board history is host-component-only.

## scenePhases-OFF regression

Engine unit test "scenePhases OFF: phase sequence is byte-identical to Spec 11":
asserts the resolved sequence is exactly `night→dawn→day→dusk→night` with NO
`sunrise`/`sunset` `phaseChanged` events. The default is false everywhere
(HOUSE_RULES, client mirror), and all 44 prior server tests + 49 prior engine
tests pass unchanged, confirming byte-identical behavior when off.

## Tests edited / added

- `test/engine/engine.test.ts`: added `narratorBoardHistory` to imports; new
  describe blocks "Spec 12: sunrise/sunset deferred resolution" (7 tests:
  off-regression, on-sequence night+day, holding-projection-no-leak, reveal
  contract, force-advance-bypasses-sunrise) and "Spec 12: game-status
  aggregates + narrator board history" (5 tests: rolesRemaining aggregate/no-
  leak/full-transparency, graveyard-per-revealOnDeath, board history night
  locked-only+last-wins+host-only, board history day votes locked-only).
- `test/server/game-room.test.ts`: added `scenePhases: false` to the
  `FIVE_PLAYER_HOUSE_RULES` fixture (Ruleset now requires it); new describe
  blocks "Spec 12: reveal command contract" (3 tests) and "Spec 12: game-status
  aggregates + scenePhases set_ruleset" (2 tests).
- `test/e2e/scene-status.spec.ts` (new): scene-holding + reveal flow; game-status
  panel; host narrator board (locked rows, stragglers, history nav).
- No existing test assertions changed except the required fixture field.

## Testid diff (added)

`narrator-vote-board`, `board-phase-nav`, `board-nav-prev`, `board-nav-next`,
`board-night-row`, `board-vote-row`, `board-night-stragglers`,
`board-day-stragglers`, `reveal-button`, `scene-holding`, `game-status-button`,
`game-status-panel`, `game-status-close`, `graveyard`, `graveyard-row`,
`roles-remaining`, `roles-remaining-row`, `scene-phases-toggle`. No testids
removed or renamed.

## Verify-only confirmations (no work, per spec §4/§5)

- Detective history is a full accumulated list: `you.investigationResults` in
  project.ts filters `state.investigationResults` (never cleared, appended each
  night) for the viewer — confirmed, unchanged.
- Locked-only current-phase already enforced: the hidden-voting filter strips
  tentative vote events from non-god viewers; the board's "locked only" is the
  host-side log-replay filter (Feature 1), not a projection change — confirmed.

## Final suite status

typecheck clean. Unit: engine 59, client 10, server 49 — all pass. E2E: 41 pass
(3 new Spec 12 specs + all prior). scenePhases-OFF regression green (byte-
identical sequence). Not committed, not deployed (per instructions).

STATUS: complete, suites green.
