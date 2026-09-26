# Spec 19 implementation notes

## Delivered

- Replaced the non-host event denylist with an explicit safe log allowlist.
  Living/public snapshots expose only public phase, runoff, vote-result,
  presence, end, and configured full-reveal death events. Unknown event types
  fail closed.
- Added a separate dead-player resolved-history projection. It retains the
  role assignment and resolved attack, investigation, death, vote-result, and
  public phase history, while stripping action submission/lock, ballot, and
  acknowledgement events.
- Kept dead-player role visibility separate from live authority: hidden current
  ballots and current night fields are absent from dead snapshots. Ballots are
  now gated to the host or an explicit realtime-voting ruleset even at
  dusk/ended, so stale persisted arrays cannot widen visibility.
- Dead resolved history merges graveyard deaths at their `playerDied` log
  sequence and sorts by day/sequence, keeping vote/runoff outcomes readable
  in chronological order without duplicating full-reveal death events.
- Added sorted, unique `attackFailedDays` to `ClientGameView`. The interstitial
  derives one current-day failed-attack line from it and derives death lines
  from the graveyard. Dead history likewise derives deaths from the graveyard
  to avoid full-reveal duplicates.
- Updated Storyteller facts to consume the public aggregate for the current
  day and updated its fixtures.
- Added `test/e2e/projection-privacy.spec.ts`, which captures serialized
  welcome/snapshot frames before navigation/start, checks host and player log
  projections, exercises a hidden-vote window, verifies the public failed
  attack/death UI and detective finding, and checks dead history across a
  resolved death and a later unresolved night.
- Added `test/engine/projection-privacy.test.ts` for allowlist behavior,
  dead live-field gating, reveal-mode death events, duplicate/earlier
  failed-attack days, all live action/ballot signal variants, stale ballot
  gating, and fail-closed unknown events.

## Verification run by implementer

```text
npx vitest run --project engine test/engine/projection-privacy.test.ts
  RED: 3 failed before the projection changes (expected privacy failures)
  GREEN: 1 file, 3 tests passed

npm run typecheck
  passed

npx vitest run --project engine
  3 files, 178 tests passed

npx vitest run --project server test/server/storyteller.test.ts
  1 file, 23 tests passed

npx playwright test test/e2e/projection-privacy.spec.ts --config=<isolated
  Playwright config> --project=chromium
  1 test passed in 17.3s on port 5192 with a dedicated
  /tmp/mafia-e2e-state-correctness-audit Durable Object state directory.
```

The targeted server command and isolated E2E server emitted the existing
Workers AI remote-binding warning; no deployment or live model call was made.
The full server suite, remaining Playwright suite, build, and phone-sized UI
run remain orchestrator verification steps. The temporary isolated E2E config
and state directory were removed only after the server exited.

## Coordination / deviations

`test/server/game-room.test.ts` still contains the pre-Spec-19 assertion that
a living detective receives a resolved `attackAttempted` event. The game-room
test owner should change that assertion to `attackFailedDays` and assert the
raw attack detail on the host projection; this implementation deliberately did
not edit that shared test file.
