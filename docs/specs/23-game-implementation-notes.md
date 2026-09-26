# Spec 23 — game and host game implementation notes

## Scope

This slice covers the shared in-game hierarchy and feedback surfaces in the
player game and host game. It does not change protocol, projection, rules,
role reveal timing, decoy actions, or any server behavior.

## Changes

- Added a shared player phase/task strip with the current file day, literal
  next action, and a separate spectator state for dead players. Scene and
  report phases say to listen or stay with the table instead of implying a
  player action.
- Made day voting and night actions announce the selected target and the
  resulting locked state. Added `aria-pressed` to target controls while
  preserving all existing test IDs and the `border-brass` reconnect contract.
- Gave morning reports and narrator holding beats full phone-height layouts,
  explicit reading instructions, and polite live regions.
- Gave dead and ended views a stronger state explanation and a clear
  follow-up path without adding any private data.
- Added a host phase “Next action” panel with a phase-appropriate instruction
  and host-only progress bar. Force advance, absence, scene reveal, log, and
  Storyteller controls remain available in their existing locations.
- Clarified the host result/rematch path and stated that seats are retained.

## Privacy and contract checks

- No role, action, vote, denominator, or pending state was added to a player
  projection. New player copy is derived only from fields already rendered by
  that player's projection.
- Mafia consensus, universal decoy pick/confirm, five-second first-assignment
  role reveal, dead resolved-only god view, scene holding behavior, and all
  existing `data-testid` hooks remain unchanged.
- No theme-specific branches or new dependencies were introduced.

## Verification

- `npm run typecheck` — passed.
- Playwright and deployment were intentionally left to the orchestrator per
  the implementation brief.

STATUS: implementation complete; orchestrator verification pending
