# Spec 11 — Implementation notes (playtest round 2)

Built against `docs/specs/11-playtest-round2.md` (v2). All four features
implemented; engine/protocol/DO/UI touched. No new runtime deps; no commit/deploy.

## Shared foundation — one generic lock-readiness helper

`lockReadiness(participants, submissions) -> {allLocked, lockedCount}` lives in
`src/engine/consensus.ts`. It answers only "has each participant locked their
own input" and is used by BOTH:
- day-vote readiness (`pendingVotes` in `machine.ts`), and
- night individual-action readiness (`pendingNight` in `machine.ts`).

Mafia factional consensus stays a separate concern in `resolveConsensus`
(unanimous/majority/designated agreement on a single target), layered on top of
lock readiness — not forked. `pendingNight = individualPending (all living
non-absent non-mafia, incl. decoy roles) + mafiaConsensusPending`.

## Feature 1 — Day vote select→confirm

- `castVote` sets `locked:false` (tentative); `confirmVote` locks;
  `unconfirmVote`/re-cast returns to tentative (engine resets `locked` on
  every re-cast, same rule as night picks).
- **`pendingVotes` REDEFINED** to count living non-absent players *without a
  LOCKED vote* (via `lockReadiness`) — not "uncast". Resolves only at
  `pendingVotes===0`.
- Untimed day does NOT auto-resolve with unconfirmed voters (host
  force-advance is the backstop). `resolveVote` now tallies **locked votes
  only** — unlocked = abstain on force/timer. All prior tie/runoff/threshold
  rules apply to the locked set; runoff re-uses the same select→confirm flow.

## Feature 2 — Universal night pick→confirm + decoy

- Added `"watch"` to `NightActionType` (`shared/game-view.ts`, re-exported by
  `types.ts`) and `decoy?: boolean` to `NightActionSpec` (`roles.ts`).
- `activeNightActionFor` now returns a synthetic `DECOY_WATCH_SPEC` for any
  living non-absent player whose role has no real night action (villager /
  minion / bomber), AND for a mafia player on a firstNightKill=false night 1
  (their kill is suppressed → they fall through to the decoy, keeping the
  night uniform). `hasNightInput` returns true for decoy roles.
- Individual night submissions now carry `locked`; generalized
  `lockAction`/`unlockAction` (renamed internal handler `setNightLock`)
  dispatch to the mafia vote OR the individual action. Night readiness = all
  living locked (real or decoy) + mafia consensus.
- **Every `resolve-night.ts` filter stays an allow-list** (`=== "protect"` /
  `"investigate"` / `"kill"` / `"roleblock"`), so `"watch"` is ignored by
  construction — no resolver change was needed.
- **Decoy privacy (correctness):** the watch target lives only in
  `state.nightActions`, never projected to other players. `resolvedLog` strips
  `actionSubmitted` (any type, incl. `watch`) for non-god viewers; the host
  god view keeps it. `you.pendingAction`/`you.nightIsDecoy` reflect the
  viewer's OWN pick only. Tested both directions (present for host, absent for
  every player/public/dead viewer).

## Feature 2b — Private detective findings

`you.investigationResults` is now rendered in the `RoleCard`
(`RoleReveal.tsx`) under a `detective-findings` block, reached via the My Role
button — NOT a dawn popup, and removed from the night drawer's
waiting-state. At dawn the detective sees the same shared Morning Report.

## Feature 3 — Morning Report acknowledge (dawn only)

- `acknowledge {gen}` command; `GameState.acknowledgedBy` (reset on every
  transition). Dawn→day advances on all-living-acked (`pendingDawnAcks===0`)
  OR the `dawnDuskBeatMs` timer backstop OR host force-advance.
- **phaseGen guard (like forceAdvance):** a stale-gen `acknowledge` is a
  no-op returning the same state ref (no broadcast). Unit + server tests.
- Interstitial dawn shows `morning-report` + `acknowledge-button` (Continue);
  after acking, a waiting message. Dusk stays a passive auto-advancing
  announcement (not acknowledge-gated this round, per spec).

## Feature 4 — Narrator role counts (Spec 06 D1 slice)

- Protocol: `set_ruleset {ruleset}` (`ClientMessage`) +
  `pendingRuleset: PendingRuleset | null` on `ClientRoomState`. `PendingRuleset`
  is a standalone structural type in `shared/protocol.ts` (no engine import —
  the `shared/` layer stays engine-free, same precedent as
  `StartGameMessage.ruleset: unknown`).
- DO: `PENDING_RULESET_KEY` defaulted to `HOUSE_RULES` at claim; `set_ruleset`
  is host-only, lobby-only, and broadcast via `touchAndBroadcast({skipActivity:
  true})` (excluded from `lastActivityAt`, per Spec 06). Broadcast only while
  `game === null`.
- UI: `HostLobby` has a live role-count editor (`role-count-<role>` steppers
  for mafia/detective/angel/suicide_bomber/minion; villagers = remainder),
  debounced `set_ruleset`, live `validateRuleset` gating Start (unlocks
  3-player games), √players mafia hint. Players see the roster (counts only)
  via `pending-ruleset-summary` in `Lobby.tsx`.

## Design decision — day-vote count leak

The team-lead brief pinned "NO living/dead-PLAYER night OR day pending-COUNT
anywhere ... a player sees only their own locked/waiting state, never a
denominator." I removed the player-facing "N of M have voted" hidden-tally
denominator AND the `voted` id list from the player projection
(`projectFor` no longer sets `view.voted`; only realtime rooms expose
`view.votes`, and only the god view sees the full tally). The player's hidden
tally now reads a "sealed ballots" message with no digits. The host god view
still sees per-seat vote/acted status. This is stricter than Feature 1's prose
(which only redefined resolution) but follows the explicit leak-ban directive
and the required no-pending-count leak test.

## Tests edited (every change deliberate — none loosened)

### `test/engine/engine.test.ts`
- New helpers: `settleDecoys(state, exclude)` (drives every remaining living
  non-mafia individual input to locked, real or decoy), `castConfirm`,
  `voteOut` now casts+confirms.
- "night kill/angel/detective": added angel+detective lock + `settleDecoys`.
- "plurality abstentions", "majority threshold", "runoff pins", "tie policies":
  votes now `confirmVote`d (force resolves from locked only).
- "mafia consensus modes": markAbsent/majority/designated sub-scenarios add
  `settleDecoys` before natural-resolution asserts (force sub-scenarios
  unchanged — force ignores the readiness gate).
- "firstNightKill=false": the mafia's suppressed-kill submit now files a decoy
  (no rejection) instead of `not_your_phase` — assertion flipped accordingly;
  added `settleDecoys`.
- "markAbsent on sole pending actor": now `settleDecoys(exclude:[detective])`
  first, so the detective is genuinely the last pending seat.
- "player-triggered completions": the last villager decoy lock (not the mafia
  lock) is the completion; added dawn acks + day confirms.
- "living player night view / join order", the 6 lock-in dawn-asserting tests,
  factionVotes projection: added `settleDecoys` before each dawn assert.
- host `acted` test: villager now `acted:false` (owes a decoy), not undefined;
  detective `acted` only after LOCK.
- lock-in protocol semantics: a villager `lockAction` with no pick is now
  `no_pick_to_lock` (they have a decoy input), not `not_lockable`.
- New Spec 11 tests: day tentative-doesn't-resolve/all-confirmed-does;
  untimed-day-no-hang-no-early-resolve; decoy-has-no-effect;
  decoy-absent-from-non-host-projection (both directions);
  night-waits-for-all-actors-incl-decoy; no-pending-count-leak (night+day);
  stale-acknowledge-noop + all-ack-advances; dawn-beat-backstop;
  **full-game N=3 (1 mafia + 2 villagers) → village wins**.

### `test/server/game-room.test.ts`
- New helpers: `settleNightRemainder`, `acknowledgeDawn`, `voteConfirmAll`.
- Full scripted game, hibernation, timer-alarm, join-order, new_game,
  and the 3 Spec-08 lock tests: added night settling + day confirms + the
  non-killer-lock assertion flipped to `no_pick_to_lock`.
- New Spec 11 describe: `set_ruleset`+`pendingRuleset` broadcast + not_host +
  not_lobby; confirm_vote gates resolution + `dayVoteLocked` projection;
  dawn acknowledge all-ack advances + stale-gen no-op.

### E2E (`test/e2e/*.spec.ts`)
- All `startGameWithSeed` helpers stash `mafia:testRoles="{}"` so Room sends
  the exact `HOUSE_RULESET` shape (the new lobby editor's default differs) —
  every seed→role-assignment mapping is preserved unchanged.
- New helpers per file: `submitAndConfirmNightTarget`, `settleWatch`,
  `acknowledgeMorning`, `castAndConfirm(DayVote|NoMurder)`.
- `game.spec.ts` A/B/C: every night now confirms real actions + files decoys
  for no-action roles (incl. the kill target while still alive) + acks dawn;
  every day vote casts+confirms; detective result asserted via My Role
  `detective-findings` (not the night drawer).
- `game-components.spec.ts`: vote-change test now covers confirm→reconsider;
  hidden-tally test asserts NO denominator/digits (leak ban); minion/villager
  now assert the decoy `night-watch-option` (idle state gone).
- `host-console.spec.ts`: `house-rules-summary`→`role-count-editor`; the
  start-gate test rewritten as the Feature-4 editor flow (3-player unlock via
  steppers + `pending-ruleset-summary`); Carol (bomber) status now `acted`
  (decoy), not `asleep`; force-advance day test casts+confirms.
- `lockin-role-instructions.spec.ts`: night scripts settle everyone; the
  instructions-lobby test uses `role-count-editor`.
- `game-reconnect.spec.ts`, `error-surfaces.spec.ts`: `testRoles="{}"` /
  comment refresh only (reach night / start, no resolution driven).

## Verification results

- `npm run typecheck` — clean.
- Unit: engine 49, client 10, server 44 — all green.
- E2E: 38 passed in one clean `--workers=1` pass (fresh `.wrangler/state`,
  one dev server).
- Decoy privacy: engine test asserts the watch target is present for the host
  log and absent from every player/public/dead projection — passing.
- No-count-leak: engine test greps the player night+day projection for
  `pending*count` / `voted` / `of N have` — none present; passing.
- Interaction parity: a villager/minion night context exposes the same
  `night-watch-option` + `night-confirm-button` a detective's picker does
  (game-components minion test) — passing.
- N=3: full-game engine test terminates with `winners: ["village"]` — passing.
- testid superset: all new testids present (`confirm-vote-button`,
  `unconfirm-vote-button`, `night-watch-option`, `night-confirm-button`,
  `morning-report`, `acknowledge-button`, `role-count-*`,
  `pending-ruleset-summary`, `detective-findings`). `minion-idle` removed (the
  minion is no longer idle — it files a decoy); no test references it.

STATUS: complete, suites green.
