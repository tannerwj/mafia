# Spec 12 — Narrator vote board · sunrise/sunset · all-player game status

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

Verify-only (should already be satisfied by Spec 11; extend only if not):
4. **Detective investigation history** — full running list (each night:
   target → result), in the private findings view.
5. **Locked votes only** — the board/log shows confirmed votes, never
   tentative picks.

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
  - **History**: browsable per day N / night N (from the engine's structured
    log + resolved state), not just the current phase.
- **Locked only**: never show tentative/in-progress picks on the board — only
  confirmed (locked) votes/actions. (Consistent with Spec 11's confirm
  mechanic; also means the log stops emitting/among-showing tentative vote
  churn.)
- **Players get a day-only view** (NOT the god board): the current/most-recent
  day's public accusation votes, governed by `votingVisibility` (hidden =
  who-has-voted + tally, for-whom at resolution; realtime = live who→whom),
  scoped to that one day. **Players NEVER see night role voting** (mafia
  targets, investigations, watches) — hard leak boundary enforced in
  `projectFor`.
- Implementation: primarily projection + UI. The host projection already
  carries votes + per-seat acted (Spec 11); add whatever structured
  per-phase vote/action detail the board needs to the HOST projection only.
  Confirm no night-action detail reaches any non-host viewer.

## Feature 2 — Optional Sunrise / Sunset (narrator-gated reveal)

- **Toggle**: a host setup option (lobby, alongside role counts) — `scenePhases: boolean`
  in the ruleset (default off). Off → behaves exactly as Spec 11 today.
- **When on**, the phase machine inserts a narrator-gated beat BEFORE each
  player-facing reveal:
  - After night resolves → **Sunrise** (narrator-only): the narrator sees the
    night outcome, narrates aloud, taps **Reveal** → advances to the dawn
    Morning Report (players see results, acknowledge per Spec 11) → day.
  - After the day vote resolves → **Sunset** (narrator-only): narrator sees
    the elimination outcome, narrates, taps **Reveal** → dusk announcement →
    night.
- **Gating**: sunrise/sunset advance ONLY on the host's Reveal (or host
  force-advance); players see a neutral "the narrator is setting the
  scene…" holding screen that reveals NOTHING about the outcome (no death
  info until after Reveal). phaseGen-guarded like other transitions.
- **No hang**: host is the sole advancer of these narrator phases; that's
  intended (host-run beat). Host force-advance always available.
- Engine: add `sunrise`/`sunset` to the phase enum, gated between
  night→dawn and (day-vote-resolve)→dusk respectively, only present when
  `scenePhases` is on. Preserve interruptible-transition + phaseGen
  contracts. Unit-test the enabled and disabled phase sequences.

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
- Projection: expose alive-role-counts to ALL viewers (this is the
  transparency choice — it does reveal exact alive-role breakdown under a
  hidden/no-reveal setup, which Tanner accepted). Do NOT reveal WHICH living
  player has which role (only the counts). Graveyard roles follow
  `revealOnDeath`.
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
- **D2 — protocol/DO**: `reveal` command (host, sunrise/sunset advance,
  phaseGen-guarded); `scenePhases` in set_ruleset; board/status projection
  fields. Pool-workers tests.
- **D3 — UI (Case File)**: host vote/status board (per-phase, history nav,
  locked-only, who-hasn't); player current-day vote view (per visibility);
  Sunrise/Sunset narrator Reveal screen + player "setting the scene" holding
  screen; all-player "The Case So Far" status panel (graveyard + roles
  remaining); scenePhases toggle in host lobby. Playwright per feature.
- **D4 — verification**: full suite green w/ documented edits; leak tests
  (players never get night voting; scene holding carries no outcome; living
  role identity never leaks); a full game WITH scenePhases on (narrator
  reveals each beat); game-status accurate mid-game.

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
