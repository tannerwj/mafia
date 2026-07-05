# Spec 08 — Team lock-in voting · always-accessible role · instructions

**v2 — 2026-07-05 · Status: approved for build**
Parent: post-launch playtest feedback (Tanner, 2026-07-05). Depends on:
Specs 01 (protocol surface), 02 (engine/night resolution), 03 (DO/protocol),
04 (player UI), 05 (host console). This is a feature increment on the
shipped, deployed game.
*v2 folds all Codex adversarial-review findings. This spec formally AMENDS:
Spec 02 → v2.8 (force/timer fallback now "locked" not "submitted"; host
`acted` = locked; `factionVotes` shape + `lockedCount`); Spec 01/03 protocol
surface (two new client messages `lock_action`/`unlock_action`, two new
rejection codes `no_pick_to_lock`/`not_lockable`). The reviewer's B2/S2/S6
worries were disproved against current code — the disagree-"hang" is
PRE-EXISTING (unanimous mode already needs force-advance to break a
submitted-but-disagreed deadlock; lock-in only moves the goalpost from
submitted→locked, adds no new hang), the absent-killer vote already drops
from both sides of the ratio via `mafiaKillers()` filtering, and designated
mode is already single-killer-gated — so those are documentation
clarifications, not code risks.*

## Goal

Three playtest-driven fixes:
1. **Team coordination is currently a blind guess.** Mafia can't see what
   their partners picked, so agreeing on a kill is guesswork. Fix: each
   teammate's *current* pick is shown live on every teammate's screen, with
   a **tentative → Lock in** flow; the factional kill resolves only when all
   living, non-absent killers have **locked** and their locked targets
   satisfy the consensus rule.
2. **Players can't reliably see their own role.** Add an always-accessible
   **"My Role"** control (one tap) in every in-game phase — without a
   permanently-on-screen badge (preserves the shoulder-surf privacy that
   press-and-hold was built for).
3. **No rules reference.** Add an **instructions/help** popup (how-to-play +
   every role's description) reachable from lobby and game.

Done looks like: in a live game, two mafia see each other's tentative picks
update in real time, one locks, the night does NOT resolve until the second
also locks on the same target; a stray mismatched tap never ends the night;
any player can tap "My Role" to see their role and open Instructions; and
the mafia stall drill / force-advance paths still behave per Spec 02.

## Non-goals

Lock-in for *individual* (non-consensus) actions — detective/angel submit
once and that stands; only faction-consensus voting gets tentative/lock
(solo roles have nothing to coordinate). A permanently-visible role badge
(explicitly rejected for privacy). Chat. Changing which roles exist.

## Pinned conventions

### Lock-in / team voting (engine + protocol + DO + UI)

- **Vote model.** A faction-consensus vote (mafia kill) now carries
  `{ voterId, targetId, locked: boolean }`. `submit_action` with a target
  sets/updates the voter's **tentative** pick (`locked:false`), always
  changeable. Two new client→server messages:
  `lock_action {}` (commit the current pick; rejection `no_pick_to_lock`
  if the voter has no target set) and `unlock_action {}` (return to
  tentative). **These two messages + the two rejection codes
  (`no_pick_to_lock`, `not_lockable`) formally amend the Spec 01/03 protocol
  surface** (`src/shared/protocol.ts`): add them to the `ClientMessage` union
  + rejection-code type, dispatch in the DO's command switch, and add the
  matching client store intent-helpers — same one-per-type pattern as every
  existing command. They apply ONLY to a living voter whose role has
  `consensus:"mafia"` during a night phase; from anyone else →
  `rejection {not_lockable}`. Phase-gate before role-gate (both reject
  safely): a `lock_action`/`unlock_action` arriving after the night has
  already resolved rejects (never silently ignored).
  Changing the target (a new `submit_action`) implicitly resets `locked` to
  false (you re-open your choice, so partners see it's back in play).
- **Single shared resolver (do this FIRST).** Consensus/readiness logic is
  currently duplicated in THREE places — `resolveMafiaTarget`
  (resolve-night.ts), `resolveConsensusReached`/`pendingNight` (machine.ts),
  and `consensusReached` (project.ts). Before adding the lock filter, extract
  ONE helper, e.g. `resolveConsensus(votes, killers, mode, { lockedOnly })`,
  and route all three call sites through it. A `locked` filter applied to
  only two of the three silently reverts the third to submit-only behavior —
  a near-untestable divergence. This is a required refactor, not optional.
- **Resolution readiness (this is the crux).** The factional kill resolves
  during the night **only** when EVERY living, non-absent killer has
  `locked:true` (EXCEPTION: `designated` mode — see below — where only the
  designated killer's lock gates readiness; non-designated killers' lock
  state is irrelevant to the gate and matters only for the teammate-view UI).
  Tentative (unlocked) picks are visible to teammates but do NOT make the
  phase ready — this is what stops a stray matching tap from ending the night
  early. An absent killer's vote (locked or not) drops out of BOTH the
  numerator and denominator via the existing `mafiaKillers()` `!absent`
  filter — do NOT delete the vote record on `markAbsent`; the filter already
  excludes it. Once all-(relevant)-killers-locked:
  - `mafiaConsensus:"unanimous"` (house): all locked targets must be equal →
    that target is the kill. All locked but NOT equal → **no resolution**;
    the phase stays open (they must reconcile) — the "consensus not reached,
    keep deciding" state, surfaced to players. (A deadlock is broken by the
    host's force-advance or the timer, below.)
  - `mafiaConsensus:"majority"`: plurality of locked targets wins (ties by
    seat order).
  - `mafiaConsensus:"designated"`: the designated killer's locked pick wins;
    only that one killer need lock — non-designated killers' lock state is
    IRRELEVANT to readiness (this is already how the current designated
    branch works: it checks only the designated killer's vote). The "EVERY
    living non-absent killer locked" gate above does NOT apply in designated
    mode; only the designated killer's lock gates it.
- **Force-advance / timer expiry** (`forceAdvance` / `timerExpired`):
  resolve the kill from **locked votes only**, by plurality (ties by seat);
  unlocked/tentative picks are discarded (not committed); zero locked → no
  kill. **This AMENDS Spec 02 v2.3's pinned "plurality among submitted"
  rule** (now: plurality among *locked*) — see the v2.8 note in Spec 02.
  **D1 must UPDATE, not merely add to, the four existing engine tests that
  currently assert a kill lands from submit-without-lock on force/timer**
  (`test/engine/engine.test.ts` ~lines 136, 161, 276, and the majority/
  designated sub-cases): they must lock their votes before asserting the
  kill, or assert "no kill" when nothing is locked. Leaving them unchanged =
  red CI; deleting them without this authorization = losing coverage. Absent
  killers remain excluded from the denominator (Spec 02 v2.3). Individual
  actions still apply their existing no-action / abstain defaults.
- **Interaction with the night-complete gate.** The night resolves when:
  all individual night actors have submitted AND the factional-kill
  readiness above holds (all killers locked). `markAbsent` on a killer
  removes them from the lock denominator (so a ghosting mafia can't block
  lock-completion — consistent with Spec 02 v2.3). A phase with zero pending
  inputs still advances immediately.
- **Projection (Spec 02 `you.factionVotes`) — BREAKING shape change, amends
  v2.6.** Each entry gains `locked`; shape:
  `factionVotes: { voterId, targetId: PlayerId | null, locked: boolean }[]`
  now covering **all** living killers (undecided → `targetId: null`), not
  just those who've picked — so the UI shows every teammate with their pick
  or "deciding…". CONSEQUENCE: `factionVotes.length` no longer means "how
  many have picked" (it's now the killer count); no test or client code may
  use `.length` as a picked-count proxy. Add `you.lockedCount: number`
  (killers currently locked). `you.consensusReached` is REDEFINED: now true
  iff all relevant killers are locked AND the consensus rule is satisfied
  (previously unrelated to locking). Host god view: the per-seat `acted`
  signal (v2.7) is AMENDED for mafia — a killer counts as "acted" only once
  **locked** (tentative = pending); non-mafia individual actors keep
  `acted` = submitted. D1 must UPDATE (not just add) the v2.7 acted test for
  the mafia case. `factionVotes` remains host/mafia-only; a dead ex-mafia's
  god view stays resolved-only (v2.2) — no live tentative picks leaked to
  the dead mid-night.
- **`phaseGen` / idempotency** unchanged; `lock_action`/`unlock_action`
  carry `now` like other commands (Spec 02 v2.5) and are ordinary
  state-changing commands (apply-persist-broadcast, bump `lastActivityAt`).

### Always-accessible role (UI only)

- A **"My Role"** button, persistently visible in every in-game phase
  (night/dawn/day/voting/dusk/ended) — a small fixed control (e.g. the mask
  icon, bottom corner, ≥44px). Tapping opens the existing RoleReveal card
  (role name + one-line ability + mafia roster/minion info as already
  granted by the projection). It stays until dismissed (tap-out / close), so
  it's readable — but nothing role-identifying is on screen until the player
  chooses to open it (privacy preserved; a neighbor sees only a generic
  "My Role" button). The initial 5s auto-reveal at game start stays.
- Dead players: the button still works (shows their real role).

### Instructions / help (UI only)

- A **help** affordance (e.g. "?" icon) in the lobby AND in-game header.
  Opens a scrollable modal: objective (Village vs Mafia), the day/night
  loop, tie/voting rules in plain language, and a description of every
  house role (villager, mafia, detective, angel, suicide bomber, minion) —
  content sourced from the EXISTING `src/client/lib/roleCopy.ts` (already
  provides `roleCopyFor(roleId) → {displayName, blurb}`, used by RoleReveal/
  HoldToPeek) — extend that file if a longer instructions blurb is needed;
  do NOT create a second `roleInfo.ts` (that reintroduces the drift this is
  meant to avoid). Static content; no server involvement.

## Deliverables

- **D1 — engine** (`src/engine`): lock state on faction votes; readiness =
  all-killers-locked; consensus/force/timer resolution per the pins;
  projection `factionVotes[].locked` + host `acted`-only-when-locked.
  Unit tests: tentative doesn't resolve; all-locked-agree resolves;
  all-locked-disagree stays open (unanimous); majority plurality of locked;
  force/timer uses locked-only; markAbsent unblocks; unlock re-opens;
  changing target clears locked.
- **D2 — protocol/DO** (`src/shared/protocol.ts`, `src/server`):
  `lock_action`/`unlock_action` + rejections (`no_pick_to_lock`,
  `not_lockable`); routed like other game commands. Pool-workers tests:
  lock/unlock round-trip; night resolves only after all lock; authority
  (non-killer lock → rejection); **lock/unlock after the night has already
  resolved → rejection (not silently ignored)**.
- **D3 — team-voting UI** (`src/client/screens/game/NightActionDrawer.tsx`):
  replace the aggregate "N of M partners have chosen" with a live
  **per-teammate list** (each killer: name → their current target or
  "deciding…", with a locked ✓ / tentative marker), your own tentative
  highlight, a **Lock in** button (disabled until you've picked; becomes
  **Unlock** once locked), and an "X of N locked · waiting…" /
  "consensus reached" / "locked but not agreed — keep deciding" status line.
  Playwright: two mafia contexts, see each other's live picks, lock flow
  resolves only on all-locked-agree.
- **D4 — My Role button + Instructions** (`src/client`): persistent My-Role
  control wired to RoleReveal in all in-game phases; help icon + Instructions
  modal in lobby + game; shared `roleInfo.ts`. Component/E2E: button opens
  role in each phase; instructions modal opens/closes; no always-on role text
  in the DOM when closed (privacy assertion).

## Acceptance criteria

CI: typecheck; engine + client + server suites green; new tests above green
AND the four force/timer engine tests UPDATED (not left red); the v2.7 acted
test UPDATED for the mafia-locked case. Privacy check is STRUCTURAL, not a
naive text grep: assert no always-mounted component renders role-identifying
text (the 5s auto-reveal Dialog and the tap-opened My-Role card both
mount-then-dismiss and are exempt — they carry a dismiss timer / open state;
a permanently-mounted role badge would fail). No new dependencies.
Live (orchestrator): on production-equivalent dev, two-mafia lock flow
resolves correctly and never resolves on tentative-only; My Role + help
reachable every phase; force-advance during a locked-disagreement resolves
by plurality-of-locked.

## Notes for implementer

- The lock is the ONLY new resolution gate — do not also change individual
  action or day-vote semantics.
- Reuse existing seat-order tie-break, absence, and phaseGen machinery;
  this rides on Spec 02's resolver, it doesn't replace it.
- Deviations → `docs/specs/08-implementation-notes.md`.
