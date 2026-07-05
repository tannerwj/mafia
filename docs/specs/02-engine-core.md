# Spec 02 — Game engine core (pure TS)

**v2.6 — 2026-07-04 · Status: approved for build**
*v2.6 (Spec 04 build fallout — two projection-contract gaps found by the UI
implementer): `you.mafiaRoster?: {id, name?}[] → PlayerId[]` present for
living MINION viewers (the role's entire ability; "minion sees mafia" was a
knowledge grant with no pinned field) and for mafia viewers (their partner
knowledge, complementing live factionVotes). `you.currentVote?: VoteTarget`
— your OWN standing vote, present for every living viewer regardless of
votingVisibility (hidden mode hides others' votes, never your own; fixes
the hard-reload-mid-vote restore gap).*
*v2.5 (build fallout — implementer caught a real signature gap):
`startGame(players, ruleset, seed, now, roles?)` — `now` (epoch ms) lets a
configured night-1 timer emit its setDeadline effect at start; `roles`
optionally injects a role registry (default: house six) — no global mutable
`registerRoles`. View types (`ClientGameView`, `Viewer`) are DEFINED in
`src/shared/game-view.ts` with no engine imports; the engine imports them
from shared (dependency points engine → shared, never the reverse).*
*v2.4 (Spec 06 review fallout): majority threshold defined w.r.t.
abstentions; `validateRuleset` signature pinned, declared semantic-only
(shape coercion is the caller's job); 5s timer floor.*
*v2.3 (Spec 05 review fallout): absent players leave consensus denominators
+ uniform factional-kill resolution on every advance path; `phaseGen`
double-fire guard on forceAdvance; `deadlineAt` + `absent` added to
projections.*
*v2.1 (Spec 03 review fallout): `GameState` gains `deadlineAt: number|null` —
see Engine interface bullet. v2.2 (Spec 04 review fallout): D6 projection
contract made explicit — mafia live faction votes, detective results shape,
own-pending-action inclusion, and NO night pending-count for living players.*
*v2 folds in all findings from Codex adversarial review (2026-07-04):
consensus timeout resolution, village-win now requires minions dead (matches
design.md — v1 draft contradicted it), elimination-mode termination backstop,
runoff edge pins, protection-as-state + reserved reactive band 450, snapshot
contract cross-ref, dead god view delayed to resolution boundaries
(physical-proximity leak), hidden-visibility log suppression, Escort fixture.
No findings overruled.*
Parent: PLAN.md §Architecture (Game engine). Depends on: Spec 00.
Grounding: docs/research/mafia-rules-research.md (NAR, attack/defense tiers,
balance formulas) and design.md (house rules).

## Goal

A pure-TypeScript engine in `src/engine/` that plays complete games of the
house six roles under a configurable ruleset, deterministically (seeded RNG,
injected clock), with zero I/O and zero Cloudflare imports. Done looks like:
a vitest suite simulates full multi-day games — every ruleset toggle, every
house role, disconnect-shaped abstentions, host force-advance — and the same
seed always produces the identical game; a Jester and a Godfather can be
defined as *test fixtures* without touching engine code, proving the v1.1
role packs are data, not surgery.

## Non-goals

DO/network integration (Spec 03). UI (Specs 04/05). The deferred role packs
as *shipped content* (v1.1) — but their structural support is in scope.
Lobby/identity (Spec 01 owns everything before `startGame`).

## Pinned conventions

- **Purity/determinism**: no `Date.now`, `new Date()`, `Math.random`, or
  platform imports anywhere under `src/engine/`. RNG (`() => number`, seeded;
  implement mulberry32) and current-time (epoch ms) are injected. Same
  `(lobby, ruleset, seed)` + same command sequence ⇒ byte-identical state
  and effects.
- **Engine interface** (the only surface Spec 03 may use):
  ```ts
  startGame(players: LobbyPlayer[], ruleset: Ruleset, seed: number)
    → EngineResult
  applyCommand(state: GameState, cmd: Command) → EngineResult
  projectFor(state: GameState, viewer: Viewer) → ClientGameView
  // EngineResult = {state: GameState, effects: Effect[]}
  ```
  The RNG's cursor lives **inside `GameState`** (`rngState: number`,
  advanced whenever consumed) — `applyCommand` takes no RNG argument, so
  replaying the same commands over a persisted state stays deterministic.
  `GameState` also carries **`deadlineAt: number|null`** — maintained by the
  engine in lockstep with its `setDeadline`/`clearDeadline` effects.
  `applyCommand(state, {timerExpired, at})` is a **no-op (empty effects, no
  rejection) unless `at === state.deadlineAt`** — this makes the DO's
  at-least-once alarm delivery exactly-once inside the engine, without the
  DO ever reading state internals. The same pattern guards manual advance:
  `GameState.phaseGen: number` increments on every phase transition;
  `{forceAdvance, gen}` no-ops unless `gen === state.phaseGen` — two host
  tabs confirming force-advance near-simultaneously advance ONE phase, not
  two (the second is stale and returns a `stale_advance` rejection so the
  console can toast "already advanced").
  `Command` (from DO): `{submitAction}`, `{castVote}`, `{retractVote}`,
  `{forceAdvance}` (host), `{timerExpired}` (DO alarm), `{markAbsent}` /
  `{markPresent}` (host/presence). `Effect`: `{setDeadline(at)|clearDeadline}`,
  `{gameEnded(winners)}` — everything else is expressed as state, which the
  DO broadcasts via `projectFor`. Commands carry `playerId` resolved by the
  DO from socket identity (Spec 01) — the engine never sees tokens.
  **Cross-spec contract (per Spec 01 snapshot semantics): the DO
  re-broadcasts a fresh personalized snapshot to every connected client
  after every applied command — no per-player diffing exists or is needed.
  Private knowledge (e.g. a detective's result, written into state at night
  resolution) reaches its owner through the next projection, automatically,
  including after a DO restart.**
- **State is a plain JSON-serializable object** (no Maps/Sets/classes) —
  the DO persists it as-is. Append-only `log: GameEvent[]` inside state for
  history/god view; public-facing text is *derived* from structured events at
  projection time, never stored as prose.
- **Phases**: `night → dawn → day → runoff? → dusk → night …` where `dawn`
  (night-resolution reveal) and `dusk` (vote-resolution reveal) are
  zero-input announcement states; their beats are **ordinary `setDeadline`
  effects** with `dawnDuskBeatMs` as the interval — Spec 03 never
  special-cases them; it always fires `timerExpired` when any deadline
  elapses regardless of phase. `forceAdvance` during dawn/dusk is accepted
  and simply skips the remaining beat (nothing pending to resolve — host
  impatience is harmless). `runoff` occurs only under the runoff tie policy.
  Terminal: `ended`. Day number increments at `night` entry; game starts at
  `night` 1 (subject to `firstNightKill`).
- **Invalid commands never throw** — they return
  `{state: unchanged, effects: [], rejection: {code, playerId}}` so the DO
  can answer that client without crashing the room. (Engine bugs may throw;
  invalid *input* may not.)
- **Night resolution = NAR** with pinned priority bands (lower resolves
  first): 100 control/redirect · 200 roleblock · 300 protect · 400 kills
  (simultaneous — a killed player's submitted action still resolves) ·
  **450 reactive/triggered (reserved — no house-six or fixture role uses it;
  the slot exists so v1.1 Bodyguard/Veteran/Hunter-style "fires in reaction
  to an attack" roles don't force a NAR rework)** · 500 investigations (read
  post-modification state). Same-band tie-break: Neutral → Mafia → Town,
  then seat order (join order at game start). Mutual-roleblock: all actions
  of both blockers fail. Passives are modifiers, not actions — unblockable.
  **Protection is a band-300 state mutation** (raises the target's defense
  tier for the night) that band-400 kill resolution *reads* — it never
  removes or redirects the kill action itself. Kills always emit an
  `attackAttempted` GameEvent (with outcome landed/failed), so future
  band-450 roles can detect that an attack occurred.
- **Kill model = attack/defense tiers**: attack `basic < powerful <
  unstoppable`; defense `none < basic < powerful < invincible`; a kill lands
  iff attack > defense. Mafia kill = basic attack. Angel protection =
  powerful defense for that night. Multiple kills on one target the same
  night: target dies once; all sources logged.
- **Votes**: one current vote per living player, changeable until phase end
  (`castVote` overwrites; `retractVote` clears). Threshold per ruleset:
  `plurality` (house) or `majority`. **Majority is pinned as: strictly more
  than half of LIVING players (fixed denominator — abstentions never shrink
  it; the abstain-never-raises-the-bar pin is a plurality-only statement).
  No candidate reaching majority ⇒ nobody eliminated (peace; tie policy
  does not apply — a failed threshold is not a tie).** `no_murder` is a first-class vote target
  when enabled. Tie resolution per `tiePolicy` — house default
  `runoff-then-peace`: tie among players → single runoff restricted to the
  tied players (2 or more; voters = all living players); any tie involving
  `no_murder`, or a tied runoff → no one dies. **`no_murder` never
  participates in a runoff** — if the top-vote tie set includes `no_murder`,
  that is peace, not a runoff-eligible tie; runoffs are constructed only
  from tied *player* targets. **A runoff's own tally uses tie-then-peace: a
  further tie among runoff candidates → peace, never a second runoff** (no
  infinite loops). A retracted vote with no replacement before phase end
  counts as abstain, identical to never having voted — retraction carries no
  penalty or memory into resolution. Other policies: `no-murder`, `random`
  (seeded RNG among tied), `kill-all`.
- **Timer expiry / absence defaults**: on `timerExpired` (or `forceAdvance`),
  unsubmitted night actions resolve as "no action"; non-voters count as
  **abstain** — abstentions are not `no_murder` votes and never win a
  plurality (if nobody votes, nobody dies). **Abstain never itself wins, but
  does not raise the bar either: a single cast vote beats N abstentions and
  elects its target. Intended — mass timeout is not a shield against a
  determined voting minority.** `markAbsent` players are treated
  as auto-defaulting instantly (their pending input never blocks a phase);
  `markPresent` restores normal behavior. A phase with zero pending inputs
  advances immediately without waiting for its timer.
- **Win evaluation order** (after every state change, first match ends the
  game): 1. Suicide-bomber day-vote win (instant, exclusive). 2. Village win
  — **zero living mafia-role players AND zero living minions** (per
  design.md: "Village Win: when all Mafia and Minions are eliminated" — the
  v1 draft's mafia-only condition contradicted the house rules; v0's code
  had the same bug). 3. Mafia-team win — parity: living (mafia + minions) ≥
  living everyone-else (suicide bomber counts as village here). The formula
  is alive even at mafia=0: surviving minions can still win the game for the
  mafia team by reaching parity, they just can't kill — the village must
  vote them out. `parityRule` semantics: `'immediate'` (house) — rule 3
  fires the moment parity holds. `'elimination'` — no early parity win;
  mafia team wins when zero village-aligned players remain, village wins per
  rule 2; anti-stall backstop: if a full dawn→dawn cycle produces zero
  deaths while rule 3's parity formula holds, the mafia-team win fires
  (parity + demonstrated deadlock terminates the game). Worked example:
  1 mafia vs 1 villager under `elimination` — mafia kills at night → mafia
  win; mafia declines to kill and day ties to peace → next dawn the backstop
  fires → mafia win. No infinite games.
- **House-six behaviors pinned**: detectives and angels each act
  **independently** (deliberate change from v0's odd group-consensus — the
  ruleset's `mafiaConsensus` applies only to the mafia factional kill:
  `unanimous` (house), `majority`, or `designated` (lowest-seat *living,
  non-absent* mafia submits — the designation moves if they die or are
  marked absent)). **Consensus timeout**: on `timerExpired`/`forceAdvance`
  with `unanimous`/`majority` unconverged, the kill resolves as plurality
  among submitted mafia votes (ties by seat order); zero submitted votes ⇒
  no kill. This is pinned — the generic "no action" default is for
  individual actions and must NOT be applied to the factional kill (it would
  silently turn unanimous mode into no-kill-most-nights).
  **Absence and consensus (pinned)**: `markAbsent` removes a player from
  every consensus/pending denominator — unanimity/majority is computed over
  *living, non-absent* mafia only, and a phase's pending-input set excludes
  absent players (this is what "auto-default instantly" means for factional
  actions). The factional kill resolves by ONE uniform rule on every advance
  path — natural zero-pending advance, `timerExpired`, or `forceAdvance`
  alike: converged per the consensus mode → that target; unconverged →
  plurality among submitted mafia votes (seat-order tie-break); zero
  submitted → no kill. So: host marks the ghosting mafia absent → remaining
  mafia (already converged) → night resolves. Only-mafia-absent → no kill.
  Angel may self-protect. Detective learns `isMafia` boolean
  (minion reads **not mafia** — they're not a mafia-role player). Minion:
  sees mafia identities from game start, no night action, counts for parity.
  Suicide bomber: wins only via day-vote elimination; a night kill on them
  is a normal death; they count as village for parity; their win ends the
  game for everyone.
- **Reveal-on-death** per ruleset: `full` (house) / `alignment` / `none` —
  affects *public* projection only; god views always see everything.

## Deliverables

**D1 — `src/engine/ruleset.ts`**: `Ruleset` type + `HOUSE_RULES` constant +
`validateRuleset(ruleset: Ruleset, playerCount: number): ValidationResult`
(structured `{errors, warnings}`; e.g. role counts vs player count, mafia
≥ 1, `runoff` requires `no_murder`, any set timer < 5s is an error — 5s is
the pinned floor, all-timers-absent is a warning). **Semantic-only**: it
assumes a shape-valid `Ruleset` (TS types are erased — runtime shape/enum
coercion of untrusted input like stored presets is the caller's job,
Spec 06's `coercePreset`). Fields (all present,
JSON-serializable): `roles: Record<RoleId, number|'auto'>`,
`mafiaCountFormula: 'sqrt'|'quarter'` (used when `'auto'`),
`firstNightKill: boolean` (house: true), `tiePolicy`, `dayVoteThreshold`,
`noMurderOption: boolean` (house: true), `mafiaConsensus`, `revealOnDeath`,
`parityRule`, `votingVisibility: 'hidden'|'realtime'` (projection-level),
`timers: {night?: number, day?: number, voting?: number, runoff?: number}`
(seconds, absent = untimed), `dawnDuskBeatMs: number`.

**D2 — `src/engine/roles.ts`**: `RoleDef` interface (id, displayName,
alignment `town|mafia|neutral`, countsForParityAs, nightAction spec
`{actionType, priorityBand, targetRule, consensus?}`, passives, knowledge
grants at start, attack/defense tiers, `winHook?`) + registry with the house
six. Structural-extensibility proof: `test/engine/fixtures/extra-roles.ts`
defines Godfather (investigation-immune passive), Jester (third-party
`winHook` on being voted out), and an Escort stub (band-200 roleblock —
exercises the NAR middle, incl. mutual-roleblock) using only exported
types — compiles and plays in tests with zero engine edits. Band coverage,
stated honestly: house six + fixtures exercise bands 200/300/400/500;
bands 100 (control/redirect) and 450 (reactive) are structurally reserved
but unexercised until v1.1 roles ship in Spec 06.

**D3 — `src/engine/machine.ts`**: phase state machine per the pinned cycle,
`startGame` (role assignment via seeded shuffle honoring D1 counts + auto
formula), command validation (right phase, living player, legal target,
authority — `forceAdvance`/`markAbsent` are host-only flags on the command,
asserted by the DO), pending-input tracking, immediate-advance-when-complete.

**D4 — `src/engine/resolve-night.ts`**: NAR resolver per pinned conventions.
Outputs structured `GameEvent`s (who died, who was saved — "saved" is public
only as "an attack failed" per house flavor, investigation results as
*private* knowledge grants).

**D5 — `src/engine/win.ts`**: evaluators in pinned order.

**D6 — `src/engine/project.ts`**: `projectFor(state, viewer)` where
`Viewer = {kind:'player', id} | {kind:'host'} | {kind:'public'}` — a dead
player is `{kind:'player'}` whose projection upgrades automatically. Living
players: own role + granted knowledge (mafia see partners; minion sees
mafia; detective sees own past results) + public state (votes per
`votingVisibility`, reveals per `revealOnDeath`).
Pinned per-player fields (the UI contract — Spec 04 renders exactly these):
- `you.pendingAction` — your own submitted-but-unresolved night action
  (present on reconnect; how "you're done, waiting" is restorable).
- Mafia only, during night: `factionVotes: {playerId, targetId|null}[]` —
  live partner kill-votes + a derived `consensusReached: boolean`. This is a
  deliberate grant: silent gameplay means the mafia coordinate *only* by
  vote signaling, so they must see each other's current picks (mirrors v0).
- Detective: `investigationResults: {day, targetId, isMafia}[]`.
- **No night pending-count for living players** — not even "N of M actors
  have acted": the denominator leaks the power-role count under closed
  setups. Non-actors see a static sleeping state; actors see only their own
  submission state. (Host/dead god views are unaffected.)
- All viewers: `deadlineAt: number|null` (phase countdown) and
  `phaseGen: number` (echoed in forceAdvance) in `ClientGameView`; each
  game-side player ref carries `absent: boolean` (host procedural action —
  public information).
**Host: live god view** — everything including pending, in-flight night
actions (the arbitrator must see the table). **Dead players: resolved god
view** — all roles, full history, all *resolved* actions, but NEVER pending
submissions of the current unresolved phase. Rationale (pinned): players sit
in one physical room; a dead player's screen mid-night must not reveal "the
detective is checking Sarah" to the living neighbor beside them. Dead god
view unlocks per phase at resolution boundaries (dawn/dusk).
`public` = spectator floor (game-end reveal per ruleset).
Under `votingVisibility:'hidden'`, non-host/non-dead projections omit
individual vote-cast/retract events entirely (not just the tally) until dusk
— living players see at most "who has voted" booleans; order-of-change leaks
tallies. Exception by necessity: runoff candidate announcement names the
tied players (you cannot run a runoff otherwise) — treated as public at that
moment while underlying tallies stay hidden.
This module is the ONLY place visibility is decided; snapshot types live in
`src/shared/` for client reuse.

**D7 — tests** (`test/engine/`): scenario DSL (`playGame(seed, ruleset,
script)`) +: full-game happy path; every tiePolicy; every mafiaConsensus;
firstNightKill off; parity both modes; suicide-bomber win (and non-win by
night kill); minion parity math; angel self-save; independent multi-detective
results; timer-expiry defaults (nobody votes ⇒ nobody dies); forceAdvance
mid-night; markAbsent unblocks; unanimous-consensus timeout → plurality
among submitted mafia votes; village win requires minions dead (mafia dead +
minion alive ⇒ game continues; minion parity ⇒ mafia-team win);
`elimination` anti-stall backstop fires; runoff: 3-way tie, tied runoff →
peace, no_murder excluded from runoff; determinism (two runs, same seed,
deep-equal states + effects); fixture Godfather fools detective; fixture
Jester ends game on day-vote; fixture Escort roleblocks + mutual-roleblock;
projection leak tests (living villager never sees any other living player's
role in any reachable state of a scripted game; `votingVisibility:'hidden'`
omits vote events for living viewers until dusk; dead player's projection
mid-night contains NO pending submissions; host's does; living villager's
night projection contains no pending-count/denominator field; mafia's
contains partner factionVotes; reconnect-shaped re-projection includes
you.pendingAction).

## Acceptance criteria

CI-verifiable:
1. All D7 tests green; `npm run typecheck` clean.
2. `grep -rn "cloudflare\|Date.now\|new Date(\|Math.random" src/engine` → no
   hits (comments excepted).
3. Determinism test present and green.
4. Fixture roles compile + play without any `src/engine` modification
   (fixtures import only from `src/engine` public exports).
5. Projection leak tests green.

Live: none (pure library) — Spec 03 carries it to the wire.

## Notes for implementer

- Zero new dependencies.
- Structured events over prose: the client renders text; the engine records
  facts.
- Keep role logic in RoleDefs/handlers — if `machine.ts` ever switches on a
  concrete role id, that's the smell the whole design exists to avoid
  (win-order rule 1 is the one sanctioned exception: suicide bomber's
  day-vote win, expressed via its `winHook`).
- Deviations → `docs/specs/02-implementation-notes.md`.
