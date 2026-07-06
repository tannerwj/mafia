# Feedback backlog — playtest round 3 (captured 2026-07-05)

Batch of Tanner feedback. Sequencing: several items build on Spec 11's
in-flight changes (phase machine, confirm/lock votes, projections), so this
becomes **Spec 12**, built AFTER Spec 11 lands & deploys — injecting into the
running Spec 11 build would collide.

## Items

1. **Narrator vote/status board** — beyond the log: a per-day / per-night
   structured view of votes (who voted for whom) INCLUDING who still hasn't
   voted/acted. Host-only (god view). Pairs with item 4.

2. **Detective investigation history** — a running list of who the detective
   has investigated and the result each night. → LARGELY COVERED by Spec 11
   Feature 2b (private "Your findings" view). Confirm it's a full history
   (day · target · result), not just the latest. Likely already satisfied by
   Spec 11; verify on that build and only extend if needed.

3. **Optional "Sunrise" / "Sunset" phases** — narrator storytelling beats
   BETWEEN night↔day. When enabled: after a phase resolves, the narrator gets
   a scene-setting beat, narrates/sets the scene, then advances; THEN players
   see the results and continue. Optional (host toggles in lobby setup).
   Interacts with Spec 11's dawn acknowledge-gate: sunrise ≈ a narrator-gated
   pre-reveal beat before the morning report; sunset ≈ same before night.
   OPEN FORK: in-person pacing beat vs typed scene text (see question).

4. **Narrator log shows locked votes only** — not every tentative/hovered
   vote, only confirmed (locked) ones. Ties to Spec 11's confirm mechanic
   (only confirmed votes are load-bearing) — mostly a log/vote-board
   filtering refinement.

5. **Persistent "game status" for ALL players** — accessible any time:
   the graveyard (who died + their roles, per revealOnDeath) AND how many of
   each role remain. OPEN FORK: showing living players the remaining
   role-counts is real information — must respect reveal/visibility settings
   (under full-reveal open setup it's derivable anyway; under hidden/no-reveal
   it would leak). See question.

## Resolved (Tanner, 2026-07-05)
- **Sunrise/Sunset**: in-person + **reveal-when-ready**. Narrator sees what
  happened, narrates aloud to the table, taps **Reveal**; only then do
  players see the results and continue. No typing. Host controls pacing.
- **Game-status role counts**: **always show full remaining counts** (per
  role) to all players, regardless of reveal setting. Tanner's explicit
  design choice for full transparency (I flagged that under a hidden/no-
  reveal setup this reveals exact alive-role breakdown; they chose it
  anyway). Simplifies the projection — just show alive counts by role.
  Graveyard (who died + roles per revealOnDeath) shown alongside.

## Vote-board visibility (Tanner confirmed 2026-07-05)
- **Narrator board: sees ALL** — day votes AND night role voting, per phase,
  incl. who hasn't locked in. God view.
- **Players: day votes ONLY** — current/most-recent day, governed by
  `votingVisibility` (hidden = tallies/who-voted, for-whom at resolution;
  realtime = live). NEVER any night role voting (mafia targets,
  investigations, watches all stay secret).

## Spec 12 scope (build after Spec 11 ships)
NEW work: (1) host per-phase vote/status board (locked votes only, + who
hasn't acted); (3) optional sunrise/sunset reveal-when-ready phases;
(5) persistent all-player game-status view (graveyard + full remaining role
counts). VERIFY-ONLY (likely already in Spec 11): (2) detective history is a
full list; (4) log/board shows locked votes only.
