# Spec 19 — Seal player snapshots

**v2 — 2026-09-26 · Status: approved after adversarial review**

## Goal

No living or public WebSocket snapshot exposes unauthorized roles, investigations, night targets, action timing, or hidden ballots through general fields, including `game.log`. Authorized private grants remain: the viewer's own `you.*`, the detective's findings, Mafia teammate picks/roster, minion roster, and documented aggregate/death reveals. Dead players see all roles and **resolved** actions, never live submissions. The host retains the full live case file. Preserve existing public morning/evening announcements and house rules.

## Confirmed failure

`projectFor` sends `resolvedLog(state, hostLive)` to all viewers, but its denylist removes only `actionSubmitted` and `acknowledged`. Immediately after `startGame`, `gameStarted.roleAssignments` reveals every seat's role. Resolved `investigationResult` and `attackAttempted` reveal detective findings and killer/target IDs. `actionLocked`/`actionUnlocked` reveal night timing. `playerDied.roleId` bypasses `revealOnDeath`. This violates the server-authoritative visibility boundary even though React does not display those fields.

## Contract

1. Use an explicit **allowlist** for living/public `log` projections, never a denylist. In a live game include only `phaseChanged`, `runoffStarted`, `voteResolved`, `playerAbsent`, `playerPresent`, `gameEnded`, and `playerDied` **only** when `revealOnDeath === "full"`. `playerDied` remains for compatibility with existing consumers, but the UI must derive deaths from `graveyard` to support all reveal modes. Unknown/future events fail closed. `gameStarted`, action/lock events, investigations, attack detail, acknowledgements, and hidden ballot events never appear in living/public logs. The same safe allowlist applies at `ended`; `players`/`graveyard` perform the intended end reveal.
2. Dead players keep **resolved history** as promised in the existing plan. A separate dead-log projection may show `gameStarted`, `attackAttempted`, `investigationResult`, `playerDied`, `voteResolved`, and other outcome events already appended by resolution. It **always strips** `actionSubmitted`, `actionLocked`, `actionUnlocked`, `voteCast`, `voteRetracted`, `voteLocked`, `voteUnlocked`, and `acknowledged`; those are submission/timing signals, not resolved outcomes. Sunrise/sunset holds are safe because resolution has not appended outcome events yet. A dead player's `you.pendingAction`, `you.nightActionLocked`, `you.currentVote`, and `you.dayVoteLocked` are absent even if stale arrays exist internally. Host log remains raw/live.
3. Preserve public failed-attack wording without sending `attackAttempted` detail. Add `attackFailedDays: number[]` to `ClientGameView`, derived server-side from **resolved** `attackAttempted` events with `outcome === "failed"`. It is a sorted unique list of day numbers. `Interstitial` reads only `includes(game.day)` for “The attack failed,” once even if two attacks failed. A landed attack is announced via `graveyard`.
4. `Interstitial` reads current-day `graveyard` for deaths, respecting `revealOnDeath`, and the safe log for `voteResolved`/`runoffStarted`. `DeadGodView` reads `graveyard` for death history and safe/resolved log for no-elimination and game-end history; it does not duplicate a death when a full-reveal `playerDied` log event also exists. `graveyard`/`players` reveal full roles at `ended` as before.
5. Split role god view from live-action authority: host sees current submissions and ballots. Dead players see every role in `players`, but not current `votes` in a hidden-voting room; only host/realtime voting may expose live ballots. Resolved dusk/ended outcomes remain public. Living players retain their own `you.*` fields and Mafia-only teammate signals as documented.
6. `HostLog` and `NarratorBoard` retain their host projection. Storyteller stays on the **public** projection and host-only delivery; its public facts read `attackFailedDays`, never raw attack actor/target. Update its fixtures accordingly.
7. Do not alter rules, roles, game state persistence, or the engine's internal event log. Do not change the default `revealOnDeath` or vote-visibility settings.

## Required regression artifact

Add a multi-context Playwright E2E at a dedicated suite path (or extend an existing game spec) that captures **serialized `welcome`/`snapshot` frames before the start broadcast** for host and uninvolved living players. Select frames by phase/gen and inspect `game.log` structurally: at start no `roleAssignments`/`gameStarted`; after night no `investigationResult`, `attackAttempted`, actor/target IDs or tiers in a living viewer's log. Host log still has them. Reach a hidden-voting `day` window, cast/confirm one vote, and assert another living viewer's `game.votes`/`voted` are absent and their log has no vote events while the host has them. In the UI, verify public deaths/failed-attack text and the detective's private finding. Cover `revealOnDeath: "alignment"` and `"none"` in projection tests; test multiple failed attacks on one day and an earlier failed day. Add a dead-view snapshot check after a death and during the next unresolved night: all roles visible, current submissions/ballots absent, historical resolved actions available. The regression must fail before the fix and pass after it.

## Verification

Orchestrator runs `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`, and a phone-size UI playthrough. The privacy E2E is the release gate. No deployment.

## Implementation notes

Implementer writes `docs/specs/19-implementation-notes.md`; do not edit this spec. No commit until orchestrator verification. Check every `ClientGameView.log` consumer for changes caused by the safe projection.
