# Spec 22 — Deterministic tie breaks and valid role counts

**v2 — 2026-09-26 · Status: approved after adversarial review**

## Goal

Identical final votes and seed produce identical outcomes regardless of network arrival order. Malformed host role counts cannot silently materialize a different roster. Preserve all existing house rules and valid setups.

## Confirmed failures

- `consensus.ts` sorts tied Mafia target IDs with `seatOf(killers, targetId)`, which returns 9999 for non-Mafia targets. `Map` insertion order then decides the kill; reversing submission order reverses it. The same wrong tie break is used in locked-plurality force/timer fallback.
- `machine.ts` passes day-vote ties to seeded RNG in first-submission order. Identical ballot multisets with the same seed can choose different victims.
- `validateRuleset` accepts negative, fractional, non-finite role counts. `materializeRoleCounts` sums those values, while `startGame` uses `Array.from({length: count})`, so the assigned roster can differ from the accepted count.

## Contract

1. Mafia target ties resolve by the lowest **voting killer seat** among tied targets, independent of input array order. For each tied target, find the lowest-seat killer who voted for it; choose the target whose supporting killer has the lowest seat, and return that killer as `actorId`. Example: seat 0 votes for target at seat 4 and seat 1 votes for target at seat 2; seat 0's target wins, regardless of arrival order or target seat. Even without a target tie, multiple killers voting for the same winning target return its lowest-seat voter as `actorId`. Applies to majority consensus and locked-plurality timer/force fallback. Existing unanimous/designated target behavior stays unchanged; unanimous actor is also deterministic. Ignore votes from non-killers and unlocked votes where the mode requires locks. State-command invariants already guarantee one vote per killer; resolver direct-call tests may assume that invariant.
2. For `tiePolicy: "random"`, sort tied player candidates by seat before applying the injected seeded RNG. A no-murder tie continues to resolve to peace under the current house rule; runoff/kill-all policies keep their documented victim set. Log ordering under `kill-all` is outside this spec.
3. The authoritative server must safely reject malformed `start_game.ruleset` with `invalid_ruleset`, never throw or start an unintended distribution. Amend the older Spec 02 shape-valid assumption for this wire boundary: `validateRuleset` must be total over runtime/untrusted input (or a server-side shape guard must run before its semantic validation). Reject missing/null/array `roles`, missing/null/non-object `timers`, and invalid count values before `materializeRoleCounts`. Every explicit role count must be a finite, nonnegative integer or `"auto"`; return stable code `role_count_invalid` with a message naming the role, e.g. `Role count for detective must be a finite non-negative integer or "auto".` Never coerce `null`, strings, booleans, `undefined`, fractional or non-finite numbers. Keep valid all-auto and explicit overrides unchanged. Preserve separate timer-floor validation.
4. Required enum/boolean/numeric ruleset fields must be valid before game start. The production server supports the house six; reject a positive unknown role count at that boundary before role lookup. Zero-count unknown extension entries remain harmless. These checks return `invalid_ruleset` and leave the host socket usable.
5. No changes to default roles, parity, tie policy, consensus mode, or game state/protocol shapes.

## Tests and verification

These are algorithms/validation, so add deterministic engine tests **before** implementation with hand-derived expected outcomes. Test both Mafia vote arrival orders for majority and locked fallback, including differing voter/target seat orders; test same winning target with reversed voter order and stable `actorId`; test random day tie with identical votes in both orders and a fixed seed; test `-1`, `0.5`, `NaN`, `Infinity`, `null`, `"1"`, `true`, omitted role values, malformed `roles`/`timers`, and valid integer counts. Add a server test sending malformed `start_game` over the real message path and asserting `invalid_ruleset` rather than a dropped socket. Existing full-game Playwright tests are the UI regression gate. If practical, add one visible force-advance E2E for tied locked Mafia picks; do not duplicate engine tests with a brittle UI sequence. Orchestrator runs `npm run typecheck`, `npm test`, `npm run test:e2e`, and `npm run build`.

Implementer writes `docs/specs/22-implementation-notes.md`, does not edit this spec or commit. No deployment.
