# Spec 13 — implementation notes

Built against v2 of the spec (thresholds revised by Tanner mid-build: an
earlier pass was built against v1's table, which had an N=20 arithmetic typo
— see "History" below).

## What was built

**Engine (`src/engine/ruleset.ts`, `src/engine/index.ts`)**

- Added `recommendedRoleCounts(playerCount): Record<RoleId, number>` exactly
  per the spec's confirmed v2 table: small-N explicit cases for n ≤ 5, formula
  for n ≥ 6 (`mafia = max(1, max(round(√n), round(n/4)))`, `minion =
  n≥16?1:0`, `detective = n≥16?3:n≥8?2:1`, `angel = n≥12?2:1`, `bomber = 1`,
  `villager` = remainder).
- `HOUSE_RULES.roles` is now all-`"auto"` for the house six (was: mafia/
  villager auto, detective/angel/bomber fixed at 1, minion fixed at 0).
- `materializeRoleCounts` rewired: every non-villager `"auto"` role resolves
  via `recommendedRoleCounts(playerCount)[roleId]`; `villager` stays the
  remainder absorber, resolved last. Explicit numbers still always win.
  Unknown/non-house `"auto"` role resolves to 0 (unchanged behavior, now
  test-covered).
- `autoMafiaCount` kept exported, unchanged, no longer called from
  `materializeRoleCounts` (mafia's auto path now goes through
  `recommendedRoleCounts`, which already blends sqrt/quarter as the spec's
  `max(round(√n), round(n/4))` — a strict superset of the old sqrt-only
  behavior through n=13, diverging upward only at larger tables). Kept for
  back-compat and because `HostLobby`'s old hint line used to call it
  directly (no longer does, see below).
- Also exported `materializeRoleCounts` from `src/engine/index.ts` (was only
  exported from `ruleset.ts`) — needed for direct unit coverage; `index.ts`
  is an orchestrator-editable exception per `CLAUDE.md`, and this is a
  same-file barrel addition, not new engine logic.

**Client**

- `src/client/lib/houseRuleset.ts`: `HOUSE_RULESET.roles` mirrors the engine's
  all-auto house six. Updated the stale doc-comment on `testRolesOverride`
  that said "hardcodes minion: 0" (no longer true).
- New `src/client/lib/hostRoleCounts.ts`: pure, framework-free helpers
  (`isAllAuto`, `countsFromRecommendation`, `countsFromRuleset`,
  `suggestionHint`, `EDITABLE_ROLES`) extracted out of `HostLobby.tsx` so
  they're unit-testable under vitest's `client` project, which runs in plain
  Node (no jsdom/testing-library in the dependency budget — see
  `test/client/RoomConnection.test.ts`).
- `src/client/screens/host/HostLobby.tsx`:
  - `countsFromRuleset` now resolves `"auto"` via `recommendedRoleCounts`
    instead of the hardcoded 1/0 fallback.
  - New `modified` state: while `false` (fresh room, or after "Reset to
    suggested"), displayed counts recompute live from
    `recommendedRoleCounts(playerCount)` on every player-count change, and
    the debounced `set_ruleset` broadcast effect is skipped entirely — no
    wire traffic for an untouched room, matching the spec's "no `set_ruleset`
    broadcast" requirement. The first stepper edit (`handleCount`) freezes
    the then-current recommendation into explicit numbers, flips `modified`
    to `true`, and broadcasting resumes on subsequent edits.
  - "Reset to suggested" button (small, top-right of the Cast the case card,
    `data-testid="reset-to-suggested"`) — visible only when `modified` — sets
    `modified` back to `false` and broadcasts one all-auto `Ruleset`
    (`scenePhases` preserved from current state, never clobbered).
  - Hint line (`data-testid="role-count-hint"`) now reads e.g. "Suggested for
    16: 4 mafia · 1 minion · 3 detectives · 2 angels · 1 bomber · 5
    villagers" (v2 numbers) instead of the old mafia-only hint.
  - n=0/1 display safety preserved: `countsFromRecommendation` /
    `suggestionHint` both clamp `playerCount` to `max(playerCount, 1)`
    internally (same posture as the old `autoMafiaCount(Math.max(playerCount,
    1), "sqrt")` call it replaces).
- `src/client/screens/Lobby.tsx` `PendingRosterCard`: resolves `"auto"` roles
  via `recommendedRoleCounts(state.players.length)` (imported directly from
  `../../engine` — this file is only reachable via `tsconfig.client.json`,
  which includes `src/engine`, so no injection needed here, unlike
  `hostRoleCounts.ts`).

## History: v1 → v2 mid-build revision

The build was first done against v1's table. While pinning the reference
table in tests I found v1's own N=20 row (`mafia=5, minion=1, detective=2,
angel=2, bomber=1, villager=10`) summed to 21, not 20 — a one-cell arithmetic
typo (the row's own listed values imply `villager=9`, matching its own
evil% column). I'd flagged this as a documented deviation (implemented the
v1 formula literally, which produced the internally-consistent `villager=9`)
without editing the spec.

Tanner then revised the thresholds for v2 (detective 2@8+/3@16+ instead of
2@14+; angel 2@12+ instead of 2@16+), superseding that table entirely. v2's
table (6/8/10/12/14/16/18/20, now including N=18) is internally consistent —
every row's six values sum exactly to n under JS's `Math.round` semantics
(verified by hand before implementing) — so **no deviation from v2 was
needed**; the v1 typo note above is kept only as build history, not a
current caveat. All test tables and the hint-line example now reflect v2.

## Deviations from the spec (current, v2)

1. **`src/client/lib/hostRoleCounts.ts` takes `recommend` as a parameter**
   instead of importing `recommendedRoleCounts` from `../../engine` directly.
   `tsconfig.client-test.json` (the vitest "client" project's typecheck
   scope) deliberately includes only `test/client`, `src/client/net`,
   `src/client/lib`, and `src/shared` — it does NOT include `src/engine`. A
   direct import broke `npm run typecheck` with `TS6307` "file not listed in
   project" errors cascading through the whole engine module graph. Injecting
   the function (same posture the engine itself uses for clock/RNG) keeps the
   new lib file inside the existing project boundary; `HostLobby.tsx` (built
   under `tsconfig.client.json`, which does include `src/engine`) passes the
   real `recommendedRoleCounts` in at every call site. This was the smallest
   change that didn't require widening a tsconfig `include` list (which felt
   like a bigger, unrequested config change for an implementer to make
   unilaterally).
2. **Hint-line role order/pluralization** isn't spelled out beyond the one
   example string in the spec (now corrected to v2's "3 detectives · 2
   angels · 1 bomber · 5 villagers" for N=16). Implemented: order mafia →
   minion → detective → angel → bomber → villagers (matching the spec's
   example's order, which
   differs from the stepper editor's own display order of mafia → detective
   → angel → bomber → minion); "mafia" does not pluralize (matches the
   spec's own "4 mafia", not "4 mafias"); every other role pluralizes
   normally; zero-count roles are dropped; villagers always shown (even at
   0). Pinned in `test/client/hostRoleCounts.test.ts` with the correct v2
   N=16 string.

## Tests landed

- `test/engine/recommendation.test.ts` (111 tests): small-N cases (n=1..5)
  pinned exactly; n≥6 reference table pinned for n∈{6,8,10,12,14,16,18,20}
  per v2; invariant loop n=1..30 (sums to n, non-negative, mafia≥1, evil<
  ceil(n/2) for n≥5, `validateRuleset(HOUSE_RULES, n)` zero errors for
  n=3..30); `materializeRoleCounts` coverage (all-auto matches recommendation
  at N∈{5,8,16,20}, explicit override wins, villager-always-absorbs, mixed
  explicit+auto, unknown-role-auto→0); full-game scenarios at N=16 and N=20
  with all-auto `HOUSE_RULES` (assigned role multiset matches the table, no
  instant parity at start, village-wins-by-elimination still fires via a
  bounded day-vote-out-evil loop).
- `test/client/hostRoleCounts.test.ts` (10 tests): `isAllAuto`,
  `countsFromRecommendation` (incl. n=0 clamp), `countsFromRuleset`
  (all-auto + explicit-wins + lingering-auto-fallback), `suggestionHint`
  (N=16 full string per v2, N=1 singular/zero-drop, n=0 clamp) — against a
  small hand-rolled fixture table (this test project can't import the real
  engine; the real function's values are pinned separately in the engine
  suite above).
- Existing suites all stay green: engine 170 total (59 pre-existing + 111 new
  in `recommendation.test.ts`), client 20 total (10 pre-existing + 10 new in
  `hostRoleCounts.test.ts`), server 49 unchanged. `FIVE_PLAYER_HOUSE_RULES`
  server fixture (`test/server/game-room.test.ts`) is already fully explicit
  and untouched/still valid.

## Verification (final, against v2)

```
npm run typecheck   # clean, no errors
npm test             # engine: 170 passed | client: 20 passed | server: 49 passed
```

(Server run prints a noisy `EnvironmentTeardownError` from
`vitest-pool-workers` after all 49 tests already reported passed — a known
workerd teardown artifact, not a test failure.)

E2E (Playwright) and live `wrangler dev` verification are the orchestrator's
job per `CLAUDE.md` — not run here.

## Addendum: E2E fixture fallout (post-gate fix round)

The orchestrator's first full E2E gate run found 22 failures, all caused by
this spec's change of `HOUSE_RULES.roles` / `HOUSE_RULESET.roles` from a
mixed explicit/auto shape to all-`"auto"`. Root cause common to every
failure: `materializeRoleCounts` builds its `counts` object by iterating
`ruleset.roles`'s entries and inserting explicit roles first, auto-resolved
roles second — so the object's key insertion order depends on which roles are
`"auto"` in the source ruleset. `src/engine/machine.ts`'s `startGame` then
does `Object.entries(counts).flatMap(...)` to build the flat role-ID array
BEFORE the seeded `shuffle()` call, so a changed insertion order silently
changes which array position (and therefore which shuffled seat) each role
lands in — even when the resulting role *multiset* is identical. Every E2E
helper that stashes `mafia:testRoles` (a test-only sessionStorage override
`Room.tsx` spreads onto `HOUSE_RULESET.roles` before sending `start_game`)
was stashing `"{}"`, which used to be a no-op against the old mixed shape but
now spreads onto the new all-auto shape and reorders `counts`'s keys.

Two failure classes, both fixed in `test/e2e/**` only (no app code touched):

**Class 1 (majority of the 22)** — seeded role-map shift. Fix: every helper
that stashes `mafia:testRoles` now merges a `LEGACY_EXPLICIT_ROLES_BASE =
{detective:1, angel:1, suicide_bomber:1, minion:0}` object (each file has its
own copy, matching this codebase's existing per-file helper-duplication
style) into the stash instead of sending `{}`. Spread onto the all-auto
`HOUSE_RULESET.roles`, this reproduces the exact pre-Spec-13 wire shape
(mafia/villager auto, the other four explicit) and therefore the exact
pre-Spec-13 `materializeRoleCounts` insertion order — verified by hand
(Node, matching `src/engine/rng.ts`'s `nextRandom`/`shuffle` exactly) against
every seed/role-map comment already pinned in each file before touching
anything, so no test body/script needed to change, only the sessionStorage
payload:
  - `test/e2e/game.spec.ts` (scenarios A/B/C, all via one `startGameWithSeed`)
  - `test/e2e/game-components.spec.ts` (`startGameWithSeed` +
    `startGameWithSeedAndRoles`, which merges its own specific patch — e.g.
    the minion `mafiaRoster` test's `{mafia:1,villager:1,minion:1,
    suicide_bomber:0}` — on top of the legacy base)
  - `test/e2e/game-reconnect.spec.ts`, `test/e2e/lockin-role-instructions.spec.ts`,
    `test/e2e/host-console.spec.ts` (single shared `startGameWithSeed`, fixes
    every seeded test in each file including the stall-drill/privacy/host-
    reconnect scenarios)
  - `test/e2e/scene-status.spec.ts`'s two non-scenePhases tests (the
    scenePhases test is Class 2, see below)

**Class 2** — tests driving the real editor UI now see the new (correct)
live pre-fill instead of the old broken hardcoded-1 default:
  - `test/e2e/scene-status.spec.ts`'s `startScenePhasesGame` drives the real
    `scene-phases-toggle` with no `testRoles` override by design (that's the
    point of the test). At 5 players the untouched editor now pre-fills 2
    mafia (`recommendedRoleCounts(5)`), but this test's choreography needs a
    SOLE mafia (one kill, no consensus round). Fixed by adding one
    `role-count-mafia-dec` click before starting — the first stepper edit
    freezes the then-current recommendation (1 mafia, 1 detective, 1 angel,
    1 bomber, 0 minion, villager absorbs the remainder = 1), which is the
    exact 1/1/1/1/0/1 mix this test already scripted, so seed 42 deals the
    identical byte-for-byte role map (verified by hand) and NO other line in
    the test needed to change.
  - `test/e2e/host-console.spec.ts`'s "editor unlocks a 3-player game" test
    (Spec 11 Feature 4 describe block) asserted the OLD broken behavior:
    Start disabled at 3 players until the host dials three power roles down
    by hand. Spec 13 makes this the headline UX win — at 3 players the
    untouched editor already live-tracks a legal roster
    (`recommendedRoleCounts(3)` = 1 mafia/1 detective/0 angel/0 bomber/0
    minion/1 villager, sums to 3). Rewrote the test per the orchestrator's
    brief: 2 players -> Start disabled (floor); 3rd joins -> Start ENABLED
    immediately with zero edits (asserts `role-count-mafia-value`="1",
    `role-count-detective-value`="1", villager `data-count`="1"); then dial
    detective +2 (via `role-count-detective-inc` twice, 1->3) to overflow the
    roster to 4 roles for 3 seats -> Start disabled with the
    `role_count_mismatch` reason text ("Role counts must equal player
    count.") and the `reset-to-suggested` button appears; clicking it
    restores the live pre-fill (detective back to 1, villager back to 1) and
    re-enables Start, with the reset button disappearing again. No app
    behavior looked wrong here — this was purely a stale expectation of the
    pre-Spec-13 bug.

Also touched (not in the failure list, comment-only, no assertion changes):
`test/e2e/error-surfaces.spec.ts`'s "joining after game started" test had a
stale comment describing the old 1-mafia-per-role default; updated to
describe the actual N=5 live pre-fill (2 mafia). The test itself never
asserted specific counts (just that Start is reachable without edits), so it
needed no behavioral change — `recommendedRoleCounts(5)` is a valid legal
roster too. `test/e2e/lobby.spec.ts` has no role-count dependency at all and
was not touched.

No case here looked like a genuine app bug — every failure traced cleanly to
a test fixture assuming the pre-Spec-13 wire shape or the pre-Spec-13
(buggy) editor default, exactly as the orchestrator's brief predicted.

Verified `npm run typecheck` clean after all E2E edits (Playwright itself not
run here — orchestrator owns the shared dev server/port per this repo's
concurrency rule).

STATUS: COMPLETE
