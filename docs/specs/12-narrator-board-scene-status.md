# Spec 12 — Narrator vote board · sunrise/sunset · all-player game status

**v2 — 2026-07-05 · Status: approved for build**
*v2 folds all Codex adversarial-review findings. Biggest change: sunrise/
sunset **defer resolution** to the host's Reveal tap (rather than resolving
then hiding), which makes the holding-screen leak structurally impossible.
Also: player day-view pinned CURRENT-PHASE-ONLY; board history reconstructed
from locked-event log replay (host-only, client-side filter); game-status
emits ONLY {roleId,count} aggregates; reveal-command contract pinned; phase-
discriminant audit; accepted count-timing tradeoff; scenePhases-off
regression test.*

**v1 — 2026-07-05 · Status: draft (pending adversarial review)**
Parent: playtest round-3 feedback (see docs/specs/FEEDBACK-backlog.md).
Depends on: Spec 11 (day-vote confirm/lock, dawn acknowledge, decoy night
actions, host per-seat acted status, role counts) — build ONLY after Spec 11
is shipped. Touches engine (sunrise/sunset phases), projection, DO, UI.

## Goal

Three round-3 features + two verify-only carryovers, all consistent with the
anti-metagaming principle (players never learn a role from interaction or
from information they shouldn't have):

1. **Narrator vote/status board** — a per-phase, god-view board for the host:
   who voted for whom (locked only) and who still hasn't voted/acted, for
   BOTH day votes and night role actions, with per-day/per-night history.
   Players get a limited day-only view (below).
2. **Optional Sunrise / Sunset phases** — narrator-gated reveal beats. When
   enabled, after a phase resolves the narrator sees the outcome, narrates
   aloud to the table, then taps **Reveal**; only then do players see the
   report and continue. In-person pacing; no typing. Host toggle in setup.
3. **All-player game status, anytime** — a view any player can open at any
   time: the graveyard (who died + their role per revealOnDeath) AND a live
   count of how many of each role remain alive.

Verify-only (CONFIRMED already satisfied by Spec 11 — no work, just confirm
in notes):
4. **Detective investigation history** — `project.ts` already filters the
   full accumulated `state.investigationResults` for the viewer (never
   cleared, appended each night); DayVoting renders the full list. Full
   history already. ✓
5. **Locked votes only** — hidden-voting filter already strips tentative vote
   events from non-god viewers; the board's "locked only" is a host-side UI
   filter (above). ✓

Done looks like: the host can, on any day/night, see the full vote/action
picture including stragglers; a game with sunrise/sunset enabled pauses for
the narrator to set the scene before each reveal; any player can pull up the
graveyard + remaining role counts mid-game; and none of this leaks night role
voting to players.

## Non-goals

New roles / win conditions / NAR changes. Full ruleset editor beyond Spec
11's role counts + the sunrise/sunset toggle. Chat. Typed narrator scene text
(explicitly out — in-person voice + Reveal tap only).

## Feature 1 — Narrator vote/status board

- **Narrator (host god view) sees ALL**, per phase:
  - Day (voting/runoff): each living voter → their **locked** day vote (or
    "—" if not yet locked / abstaining), plus a tally, plus **who hasn't
    locked**.
  - Night: each role's action — mafia kill target(s) + consensus/lock state,
    detective's target, angel's target, and **who hasn't locked** their night
    submission (decoys included as "acted", their target need not be shown or
    shown as a neutral "watching"). This is the "who's stalling tonight" view.
  - **History**: browsable per day N / night N. `state.votes`/`mafiaVotes`/
    `nightActions` are CLEARED each phase, so history is **reconstructed by
    replaying `actionLocked`/`voteLocked` log events** (matched by
    actorId+day, last-locked-wins) — a host-only derived helper in
    `project.ts`, NOT new archival state and NOT by keeping the raw arrays
    around (which would leak tentative churn). "Locked only" falls out for
    free because we key off the `*Locked` events. (D1 engine deliverable.)
- **Locked only**: the board renders only confirmed (locked) picks. The host
  is fully trusted (god view), so this is a **client-side UI filter** on the
  raw host projection — do NOT add a `lockedOnly` projection variant.
- **Players get a day-only view** (NOT the god board): **CURRENT-PHASE-ONLY,
  no history** — literally whatever `state.votes` holds right now for the
  active day/runoff, governed by `votingVisibility` (hidden = who-has-voted +
  tally, for-whom at resolution; realtime = live who→whom). After resolution
  `state.votes` is empty, so there is no past-day view for players — that's
  intended; history is HOST-ONLY. **Players NEVER see night role voting** —
  do NOT reuse the host board's history plumbing for any player path.
- Implementation: primarily projection + UI, plus the host-only log-replay
  history helper. Any night/history detail lives ONLY on the host projection;
  confirm none reaches a non-host viewer.

## Feature 2 — Optional Sunrise / Sunset (narrator-gated reveal)

- **Toggle**: a host setup option (lobby, alongside role counts) — `scenePhases: boolean`
  in the ruleset (default off). Off → behaves exactly as Spec 11 today.
- **Mechanism — DEFER RESOLUTION (this is the leak-proof design).** The
  danger: if the night RESOLVES (victim marked dead, `playerDied` logged)
  and THEN we try to hide it during sunrise, any missed field leaks the
  death. Instead, when `scenePhases` is on, the night-readiness gate (all
  locked) transitions to **`sunrise` WITHOUT running `resolveNight`** — the
  night stays UNRESOLVED. Nothing is computed, so nothing can leak. The host
  taps **`reveal`** → THEN `resolveNight` + `evaluateWin` run → transition to
  `dawn` (Morning Report; players acknowledge per Spec 11) → day. Sunset is
  symmetric: day-vote-readiness (all locked) → `sunset` (vote UNRESOLVED) →
  host `reveal` → `resolveVote` + win → `dusk` announcement → night.
- **What the narrator sees / narrates from**: during sunrise/sunset the host
  god-view already shows every submitted+locked action/vote (mafia target,
  angel protect, detective pick; day votes) — the narrator narrates from
  those inputs (they can see exactly what's coming). No resolved-outcome
  projection is needed pre-reveal.
- **Players during sunrise/sunset**: a neutral "the narrator is setting the
  scene…" holding screen. Because the night/day is genuinely UNRESOLVED,
  the projection has no death/outcome to leak — `players[].alive` and the
  log are still pre-resolution. (Verify the holding projection exposes no
  action detail either.)
- **`reveal` command contract (pinned)**: host-only; legal ONLY in
  `sunrise`/`sunset` (else reject `reveal_not_active`); **rejects loudly on
  stale phaseGen** (`stale_advance`, like `forceAdvance` — a single trusted
  actor whose UI should disable the button, NOT the silent no-op that
  `acknowledge` uses for many uncoordinated callers). Host force-advance also
  works. No hang (host-run beat by design).
- **Engine**: add `sunrise`/`sunset` to the `Phase` enum, present ONLY when
  `scenePhases` on; when off, the phase sequence + projection shape are
  **byte-identical to today** (regression-tested, C3). **Audit EVERY
  `game.phase ===` / phase `switch` across client AND engine** (e.g.
  `GameScreen.tsx` night?drawer:dayvoting is a 2-arm conditional — sunrise/
  sunset would wrongly fall into DayVoting; `tintFor` is non-exhaustive) —
  add explicit sunrise/sunset arms, don't rely on fallthrough. Preserve
  interruptible-transition + phaseGen contracts. Unit-test both the enabled
  and disabled sequences + that the holding-phase projection leaks no outcome.

## Feature 3 — All-player game status view

- A **status panel** any player (living or dead) can open any time (a button,
  Case File themed — e.g. "The Case So Far"):
  - **Graveyard**: each dead player, cause (night/vote), day, and role per
    `revealOnDeath` (full/alignment/none).
  - **Roles remaining**: a live count of how many of each role are still
    alive — **always shown in full** (Tanner's explicit transparency choice,
    2026-07-05), regardless of reveal setting. e.g. "Alive: 2 mafia · 1
    detective · 1 angel · 4 villagers".
  - Alive/total headcount.
- Projection: expose alive-role-counts to ALL viewers as **`{roleId, count}`
  aggregates ONLY** — NEVER a per-living-player array, even name-stripped
  (player order is join order, so a positional per-player list lets a client
  map position→identity; DeadGodView's per-player list is NOT the pattern to
  copy here — group and count). Graveyard roles follow `revealOnDeath`.
- **Accepted tradeoffs (state explicitly, per Tanner's transparency choice)**:
  (a) full counts reveal the exact alive-role breakdown under a hidden/
  no-reveal setup; (b) because counts update in real time, a death's timing
  can retroactively correlate to a role change in the count even under
  `revealOnDeath:"none"` — both accepted, same tradeoff as showing counts at
  all.
- This is read-only, always-available; must not interfere with phase flow.

## Hard constraints

- `projectFor` is the sole visibility authority. Players never receive night
  role-voting detail; sunrise/sunset holding screens carry no outcome data;
  game-status exposes role COUNTS (per Tanner) but never which living player
  is which role.
- Preserve testids; new ones added (`narrator-vote-board`,
  `board-phase-nav`, `reveal-button` (sunrise/sunset), `scene-holding`,
  `game-status-button`, `graveyard`, `roles-remaining`, `scene-phases-toggle`).
  Document any changed tests.
- Case File identity; decorative layers pointer-events:none; no external
  assets; ≥44px; reduced-motion; no new runtime deps; mobile-first.

## Deliverables

- **D1 — engine**: optional `sunrise`/`sunset` phases (`scenePhases` ruleset
  flag) narrator-gated between night↔reveal and day↔reveal; alive-role-count
  in projection for all viewers; host per-phase structured vote/action detail
  (host-only); confirm detective history is a full list. Unit tests:
  scene-phases-on sequence, scene-phases-off sequence (unchanged), holding
  screen carries no outcome, role-counts present for all viewers but no
  living-player role identity leaks, night detail host-only.
- **D2 — protocol/DO**: `reveal` command (host-only, sunrise/sunset only,
  `stale_advance` on stale gen, `reveal_not_active` when no scene phase is
  active — enumerated for pool-workers assertions); `scenePhases` in
  set_ruleset; board/status projection fields. Pool-workers tests incl.
  reveal-when-off rejects cleanly.
- **D3 — UI (Case File)**: host vote/status board (per-phase, history nav,
  locked-only, who-hasn't); player current-day vote view (per visibility);
  Sunrise/Sunset narrator Reveal screen + player "setting the scene" holding
  screen; all-player "The Case So Far" status panel (graveyard + roles
  remaining); scenePhases toggle in host lobby. Playwright per feature.
- **D4 — verification**: full suite green w/ documented edits; leak tests
  (players never get night voting; sunrise/sunset holding projection carries
  NO outcome — assert victim still shows alive + no playerDied in player log
  until after reveal; game-status emits only {roleId,count}, no per-player
  array); a full game WITH scenePhases on (narrator reveals each beat);
  **a regression test asserting scenePhases OFF produces an identical phase
  sequence + projection shape to pre-Spec-12** (C3 backstop); game-status
  accurate mid-game.

## Acceptance criteria

CI: typecheck; unit suites green; E2E green w/ edits listed; testid superset;
leak tests green; grep gates.
Live (orchestrator): a full game with sunrise/sunset on — confirm players see
a neutral holding screen until the narrator taps Reveal, then the report;
open the game-status panel as a living player mid-game (graveyard + remaining
counts correct); host board shows who hasn't locked, day + night, history;
players' day view shows day votes only, never night. Screenshot new screens.

## Notes for implementer

- Sunrise/sunset holding screen is a leak surface — it must show NOTHING
  about the night/day outcome (no "someone died" hint) until the narrator
  reveals. Test it.
- The narrator board is god-view; the player day-view is a separate, strictly
  day-only projection path. Do not let night-action detail cross into the
  player path.
- Reuse Spec 11's acknowledge/phaseGen/lock machinery; don't fork.
- Deviations → `docs/specs/12-implementation-notes.md`.
