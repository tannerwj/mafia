# Spec 11 — Playtest round 2: uniform interaction + narrator role counts

**v2 — 2026-07-05 · Status: approved for build**
Parent: live playtest feedback (Tanner, 2026-07-05). Depends on: shipped app
(specs 00–05, 08, 10) + engine v2.8, and pulls forward Spec 06 D1's
`set_ruleset`/`pendingRuleset` protocol slice (never built). Touches
engine/protocol/DO/UI.
*v2 folds all Codex adversarial-review findings. Biggest changes vs v1:
(a) ALL night actions become pick→confirm (not just mafia) — this kills the
"mafia are the only ones who lock" tell and makes night interaction truly
uniform; (b) day-vote lock and night-action lock share ONE generic
lock-readiness helper (the v1 "reuse" didn't type-check); (c) explicit
no-hang backstop; (d) `"watch"` decoy action type + `decoy` RoleDef flag;
(e) NO living-player night/day pending-count (preserves the Spec 02 leak
ban); (f) detective result goes to a PRIVATE view, not a dawn popup (another
tell); (g) dusk acknowledge-gate CUT to dawn-only (blast-radius); (h) N=3
full-game test.*

## Goal

Playtest fixes unified by one principle — **a player's role must not be
inferable from their interaction pattern** (who taps, when, how much, what
extra UI they get). Today villagers sit idle while power roles tap; the day
vote is one careless tap; the mafia are the only ones who "lock"; the
detective alone gets a result popup. Each leaks information at a physical
table. After this, in every phase every living player performs the
same-shaped interaction at the same time.

1. **Day vote = select → confirm.**
2. **Every living player picks a target at night and confirms it** — real
   roles' picks do their real thing; no-action roles pick someone to "watch"
   (cosmetic, leak-safe). Same pick→confirm flow for everyone.
3. **Morning report** everyone must acknowledge before the day begins.
4. **Narrator sets role counts** in the lobby (also unlocks < 5 players).

## Non-goals

New roles; changed win conditions or NAR resolution; a full ruleset editor
(only role COUNTS editable this round); chat; dusk acknowledge-gate (cut to a
prominent auto-advancing announcement — dawn is the must-have; dusk gate is a
tracked fast-follow).

## Shared foundation — one generic lock-readiness helper

v1 said day votes "reuse the mafia lock." They can't literally:
`resolveConsensus`/`resolveLockedPlurality` (consensus.ts) are typed against
`MafiaVote`/killer `PlayerState[]` with consensus MODES; day votes are a flat
`{playerId,target,locked}[]` with plain plurality/threshold. So: **factor a
single generic** `lockReadiness(participants, submissions)` →
`{allLocked: boolean, lockedCount}` used by BOTH (a) night individual-action
readiness, (b) day-vote readiness. Mafia factional CONSENSUS
(unanimous/majority/designated) stays its own `resolveConsensus` on top —
that's a distinct concern from "has each participant locked their own input".
This is the "shared helper, not a forked second implementation" the Spec 08
review demanded; pin it, don't imply it.

## Feature 1 — Day vote: select → confirm

- `cast_vote` sets a **tentative** day vote (`locked:false`), freely
  changeable (incl. `no_murder`); `confirm_vote` locks it; `unconfirm_vote`
  or re-casting a different target returns it to tentative.
- **Readiness**: redefine `pendingVotes` (machine.ts) to count living players
  **without a LOCKED vote** (not merely without a cast). The phase resolves
  only when `pendingVotes===0` (all living locked). ⚠️ The implementer MUST
  change `pendingVotes` itself, not just prose — leaving it counting
  "uncast" would resolve early on all-tentative (the opposite bug).
- **No-hang backstop (pinned)**: an untimed day (`timers.day` unset — legal,
  the house default) with unconfirmed voters does NOT auto-resolve; the
  **host force-advance is the backstop** (this is a host-arbitrated party
  game — the narrator ends a stalled phase, consistent with the accepted
  abandoned-room tradeoff). A configured day timer also resolves it. On
  force/timer: resolve from **locked votes only** (plurality per
  `dayVoteThreshold`; unlocked = abstain; existing single-vote-beats-N-
  abstentions and nobody-locked⇒nobody-dies rules apply to locked votes;
  tie/runoff unchanged; runoff uses the same select→confirm flow). The lobby
  role-count editor SHOULD surface a hint recommending a day timer for
  unattended play, but timers stay optional.

## Feature 2 — Every player picks & confirms a target at night

- **All night actions are pick→confirm**, using the shared lock helper.
  Real actions unchanged in EFFECT (mafia factional kill; detective
  investigate; angel protect) but now each actor **confirms** their pick, and
  no-action roles (villager, minion, suicide bomber — any RoleDef with no
  real `nightAction`) get a **decoy: "keep an eye on someone"** — pick a
  living player, confirm. Identical flow for everyone → no "only power roles
  tap / only mafia lock" tell (fixes review S2).
- **Decoy mechanics**: add `"watch"` to the `NightActionType` union
  (types.ts + shared/game-view.ts) and a `decoy: true` flag on the
  `NightActionSpec` (roles.ts) so `hasNightInput` returns **true** for decoy
  roles (they count for readiness) while `activeNightActionFor` yields the
  inert `"watch"` type. **Every resolver in resolve-night.ts is an allow-list
  (`actionType === "specific"`)** — `"watch"` is ignored by construction;
  pin that resolvers stay allow-lists (a future deny-list would silently
  break leak-safety). A `"watch"` target creates NO visit any current
  mechanic observes; flag for v1.1 tracker/watcher roles.
- **Night readiness** = every living, non-absent player has a **locked**
  night submission (real or decoy) AND mafia consensus is met. Re-derive and
  pin `pendingNight` = `individualPending (now incl. decoy roles via
  hasNightInput) + mafiaConsensusPending`. `markAbsent` excludes a player
  from the set (unchanged). Zero-pending fast path unchanged.
- **NO living-player pending-count (hard — Spec 02 D6 leak ban)**: no
  living/dead player may see any aggregate "N of M have acted" for the night,
  nor a per-seat acted list — that leaks the power-role count under closed
  (custom-count) setups. Only the **host** god-view sees per-seat acted/watch
  status. A player sees only their own submission state ("your choice is
  locked — waiting for the night to end"), never a denominator.
- **Leak-safety (highest risk)**: a decoy (`"watch"`) target is **private** —
  filtered out of every non-host projection in `projectFor`, never in
  `factionVotes`/log/reveal-on-death, never shown to the dead god-view as a
  *live* pick (dead view stays resolved-only). Test from both sides: present
  for host, absent for every player/public/dead viewer.

## Feature 2b — Detective result is private, not a dawn popup (fixes S3)

The detective's investigation result must NOT auto-pop at dawn (unique screen
content = a tell). Deliver it to a **private, pull-only view** — a "Your
findings" section reachable via the My Role / role card, visible only to the
detective, updated after night resolution. At dawn the detective sees the
same shared Morning Report + Continue as everyone else.

## Feature 3 — Morning report, acknowledged by all (dawn only)

- **dawn** shows a **Morning Report** to every player (dead included, via god
  view): who died (role per `revealOnDeath`) or "the night passed — no one
  died", plus existing attack-failed/save flavor. Every living player taps
  **Continue** (`acknowledge` command) to advance.
- **Advance rule**: dawn → day when **all living acknowledged OR the
  `dawnDuskBeatMs` backstop elapses OR host force-advance** — whichever
  first. So it can't hang, but everyone *can* see it and it's prominent. The
  beat is now a backstop, not the primary advance.
- **`acknowledge` staleness guard (pinned, like forceAdvance)**: `acknowledge`
  carries `gen`; if `gen !== state.phaseGen` it is a no-op/rejection (a queued
  ack arriving after the phase advanced must not ack the next phase). Unit
  test required.
- **dusk** (day-vote result): keep a prominent announcement of who was
  eliminated (shown to all, auto-advances on the beat) — NOT acknowledge-
  gated this round (blast-radius; tracked as a fast-follow).

## Feature 4 — Narrator sets role counts (implements Spec 06 D1 slice now)

- We are **implementing Spec 06 D1's protocol now** (it was drafted/approved,
  never built): add `set_ruleset {ruleset}` to `ClientMessage`, add
  `pendingRuleset: Ruleset | null` to `ClientRoomState` (amends Spec 01 D1),
  broadcast it in the lobby snapshot.
- **Host lobby**: editable role-count section — steppers for mafia /
  detective / angel / suicide bomber / minion; villagers = remainder (or
  explicit). Live validation via `validateRuleset(ruleset, playerCount)`;
  invalid → Start disabled with the reason; valid → enabled. This unlocks
  arbitrary small setups (1 mafia + 2 villagers = 3 players — validation
  already permits it). `set_ruleset` is host-only, lobby-only, debounced;
  excluded from `lastActivityAt` (per Spec 06, so idle editing can't
  immortalize an empty room).
- **Players see the roster** (counts only, not assignments) via
  `pendingRuleset` in the lobby.
- `start_game` sends the chosen ruleset (already supported). Only counts
  editable; other ruleset fields stay `HOUSE_RULES`. Optional √players mafia
  hint; never blocks.

## Hard constraints

- Server-authoritative; `projectFor` is the sole visibility authority (decoy
  + no-count leak-safety ride on it). No secret leaves the projection.
- No testid renamed/removed (new ones added: `confirm-vote-button`,
  `unconfirm-vote-button`, `night-watch-option`, `night-confirm-button`,
  `morning-report`, `acknowledge-button`, `role-count-<role>` steppers,
  `pending-ruleset-summary`, `detective-findings`). Behavior genuinely
  changed, so test churn is expected — see the enumerated list below;
  document every edit; do NOT loosen an assertion to pass.
- Case File identity preserved on new controls; decorative layers
  `pointer-events:none`; no external assets; mobile-first ≥44px; reduced
  motion; no new runtime deps.

## Tests that MUST change (enumerated up front — do not discover ad hoc)

- `test/e2e/game.spec.ts` all three full-game scenarios: every
  `night-target-option` click now also needs a confirm; every villager (and
  other no-action role) must now submit+confirm a `night-watch-option` or the
  night never completes; every `vote-option` click now needs
  `confirm-vote-button`; dawn now needs `acknowledge-button` taps.
- The scripted assertion that non-actor villagers sit in an idle "town
  sleeps, nothing to submit" state (game.spec.ts ~line 428) FLIPS — villagers
  now have a decoy submission. Update it.
- `game-components.spec.ts` hidden-tally / vote-highlight tests: adapt to the
  confirm step.
- `host-console.spec.ts` night-status: host still sees per-seat acted; now
  covers every seat.
- `lockin-role-instructions.spec.ts`: mafia lock flow still holds; add that
  non-mafia now also confirm.
- Any test asserting the detective sees a dawn result popup → move to the
  private findings view.

## Deliverables

- **D1 — engine**: generic `lockReadiness`; day-vote `locked` +
  `confirm/unconfirm` + redefined `pendingVotes` + force/timer resolution;
  `"watch"` type + `decoy` flag + every-player night readiness + redefined
  `pendingNight`; decoy leak-safe projection; private detective findings;
  dawn `acknowledge` + phaseGen guard + backstop; confirm `validateRuleset`
  sub-5. Unit tests incl.: tentative-doesn't-resolve (day+night);
  all-locked-resolves; untimed-day-needs-force (no hang, no early resolve);
  decoy-has-no-effect; decoy-absent-from-non-host-projection;
  night-waits-for-all-actors incl. decoy; no living pending-count field
  anywhere; stale acknowledge no-ops; **full-game N=3 (1 mafia + 2 villagers)
  scripted scenario terminates correctly**.
- **D2 — protocol/DO**: `confirm_vote`/`unconfirm_vote`, `acknowledge`,
  `"watch"` submit, `set_ruleset`+`pendingRuleset`; route/reject; pool-workers
  tests.
- **D3 — UI (Case File)**: day select→"Confirm accusation"; universal night
  pick→"Confirm"; "keep an eye on someone" panel (same shape as real
  pickers); private "Your findings" (detective, via role card); Morning
  Report + "Continue"; host role-count editor + live validation +
  player roster card. Playwright per feature.
- **D4 — verification**: full suite green w/ documented edits; decoy-privacy
  + no-pending-count leak tests; interaction-parity test (a villager night
  context exposes the same pick+confirm testids a detective does).

## Acceptance criteria

CI: typecheck; unit suites green; E2E green w/ every edited test listed +
justified; testid superset; leak/parity tests green; grep gates.
Live (orchestrator): a full game where every player picks a night target
(villagers included) + confirms, everyone confirms day votes, everyone
acknowledges the morning report; a 3-player game via edited counts; decoy
privacy spot-check; screenshot new screens; real-click every new control.

## Notes for implementer

- Anti-metagaming is the whole point: if any change lets an observer
  distinguish a role by interaction (extra tap, extra UI, unique popup,
  a visible count), it's wrong. S2 (mafia lock) and S3 (detective popup) are
  fixed by universal-confirm + private-findings; don't reintroduce them.
- Decoy leak-safety and the no-pending-count ban are correctness, not
  cosmetics — test both directions.
- One shared lock helper; do not fork a parallel day-vote lock system.
- Deviations → `docs/specs/11-implementation-notes.md`.
