# Spec 22 implementation notes

## Delivered

- Made mafia target ties deterministic. Majority consensus and locked-plurality
  fallback rank tied targets by the lowest seat among the killers supporting
  each target, then use that same lowest-seat killer as the action actor. The
  existing unanimous and designated modes keep their target semantics; the
  unanimous actor is deterministic as well.
- Made seeded random day ties independent of vote arrival order by sorting tied
  player IDs by seat before consuming the seeded random pick.
- Made `validateRuleset` total over runtime wire input. It rejects malformed
  rules/role/timer containers, missing or invalid required rule fields, and
  role counts that are not finite non-negative integers or `"auto"`, while
  retaining the existing timer floor and semantic checks.
- Added the production server boundary check that rejects positive unknown role
  IDs with `invalid_ruleset` before `startGame` can call `getRole` and throw.
  Unknown roles with zero count or `"auto"` remain available to the engine's
  custom role-pack path, consistent with the existing Spec 13 behavior.

## Tests and verification

The new algorithm and validation coverage is in
`test/engine/deterministic-fairness-validation.test.ts`. Server coverage for
malformed rules, positive unknown roles, and missing required fields is in
`test/server/game-room.test.ts`.

```text
npx vitest run --project engine test/engine/deterministic-fairness-validation.test.ts
  1 file, 22 tests passed

npx vitest run --project server test/server/game-room.test.ts \
  -t 'malformed ruleset shape|positive unknown role|missing required rule field'
  1 file, 3 tests passed, 83 skipped

npx vitest run --project engine
  4 files, 200 tests passed

npm run typecheck
  passed

git diff --check
  passed
```

Before the implementation, the focused engine tests reproduced arrival-order
dependent mafia targets/actors and random day victims, and malformed role
counts either passed or caused shape errors. The focused malformed server test
also reproduced a `TypeError` during `start_game`; the positive unknown-role
case reproduced `Error: Unknown role: bogus` from `getRole`, and a missing
`parityRule` could start the game. Each now returns `invalid_ruleset` without
starting the room.

The server tests emit the existing local Workers AI remote-binding warning;
no deployment or live model call was made.

## Scope and follow-up

No protocol fields, defaults, house rules, or role registry behavior were
changed. The engine remains usable with a custom registry through `startGame`;
the unknown-role check is intentionally at the house-game server boundary.
Full repository and E2E verification remain orchestrator steps.
