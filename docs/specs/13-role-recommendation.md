# Spec 13 — Scaled role recommendation (light spec)

**v2 — 2026-07-06 · Status: approved for build (scaling table confirmed by
Tanner via orchestrator Q&A; "mafia + minion at 16+" flavor chosen; v2
revises power-role thresholds per Tanner — detectives and second angel
arrive earlier: det 2@8+/3@16+, angel 2@12+).**
Tier: light (per playbook §10b — engine math + lobby defaults; not
leak/protocol-critical; no adversarial review round; verified by tests).
Parent: research `docs/research/mafia-rules-research.md` §4. Amends the
role-count parts of Specs 06/11. Baseline: `edbe0d6`.

## Problem (audit findings)

1. Only mafia auto-scales (`autoMafiaCount` = round(√n)); detective, angel,
   suicide bomber are fixed at 1 and minion at 0 no matter the table size —
   too thin on power roles at 14+.
2. The lobby pre-fill is broken in practice: `countsFromRuleset`
   (`HostLobby.tsx:39`) resolves `"auto"` mafia to a hardcoded **1**, so the
   editor pre-fills 1 mafia at any N; the √n number is only hint text. The
   pre-fill also never re-tracks as players join/leave.
3. Untouched `HOUSE_RULES` are invalid at N=3–4 (fixed power roles overflow
   the player count).

## The recommendation (confirmed with Tanner — do not change the table)

New pure function in `src/engine/ruleset.ts`:

```ts
export function recommendedRoleCounts(playerCount: number): Record<RoleId, number>
```

For n ≥ 6:

- `mafia`  = max(1, max(round(√n), round(n/4)))  — identical to today's
  √n default through 13 players, scales up at very large tables.
- `minion` = n ≥ 16 ? 1 : 0
- `detective` = n ≥ 16 ? 3 : n ≥ 8 ? 2 : 1
- `angel`     = n ≥ 12 ? 2 : 1
- `suicide_bomber` = 1
- `villager` = n − (sum of the above)   (never negative by construction for n ≥ 6)

Small-table explicit cases (must be valid — today's defaults aren't):

| n | mafia | detective | angel | bomber | minion | villager |
|---|---|---|---|---|---|---|
| 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| 2 | 1 | 0 | 0 | 0 | 0 | 1 |
| 3 | 1 | 1 | 0 | 0 | 0 | 1 |
| 4 | 1 | 1 | 1 | 0 | 0 | 1 |
| 5 | 2 | 1 | 1 | 1 | 0 | 0 |

(n=5 exactly matches today's materialized house rules — known-good live game.)

Reference table (n ≥ 6 formula; these exact values are the confirmed design
and MUST be pinned in a unit test):

| n | mafia | minion | detective | angel | bomber | villager | evil% |
|---|---|---|---|---|---|---|---|
| 6  | 2 | 0 | 1 | 1 | 1 | 1 | 33% |
| 8  | 3 | 0 | 2 | 1 | 1 | 1 | 38% |
| 10 | 3 | 0 | 2 | 1 | 1 | 3 | 30% |
| 12 | 3 | 0 | 2 | 2 | 1 | 4 | 25% |
| 14 | 4 | 0 | 2 | 2 | 1 | 5 | 29% |
| 16 | 4 | 1 | 3 | 2 | 1 | 5 | 31% |
| 18 | 5 | 1 | 3 | 2 | 1 | 6 | 33% |
| 20 | 5 | 1 | 3 | 2 | 1 | 8 | 30% |

Invariants (property-test n = 1..30): counts sum to n; all ≥ 0; mafia ≥ 1
for n ≥ 1; evil team (mafia + minion, i.e. `countsForParityAs === "mafia"`)
strictly < ceil(n/2) for n ≥ 5 so the game never starts at/awarding parity;
`validateRuleset(all-auto HOUSE_RULES, n)` has zero errors for every n ≥ 3.

**It is a recommendation, not a lock.** The host stepper editor (Spec 11)
keeps full override power; villagers remain the remainder; `validateRuleset`
remains the only gate.

## Engine changes (`src/engine/ruleset.ts` only)

- Add `recommendedRoleCounts` (above). Pure; no I/O; export from
  `src/engine/index.ts`.
- `HOUSE_RULES.roles` becomes all-`"auto"` for the house six (mafia,
  detective, angel, suicide_bomber, minion, villager).
- `materializeRoleCounts`: an `"auto"` role now resolves to
  `recommendedRoleCounts(playerCount)[roleId]` — EXCEPT `villager`, which
  stays the remainder absorber (`max(0, n − used)`, resolved last, exactly
  one absorber as today). Unknown/non-house `"auto"` role → 0. Explicit
  numbers always win (host override).
- `autoMafiaCount` stays exported (back-compat + formula display), but the
  mafia `"auto"` path resolves via `recommendedRoleCounts` (which already
  blends sqrt/quarter as max of both). `mafiaCountFormula` field is retained
  on the wire — note the semantic change in implementation notes.
- `validateRuleset` semantics unchanged.

## Client changes

- `src/client/lib/houseRuleset.ts` — mirror the all-auto roles.
- `HostLobby.tsx`:
  - `countsFromRuleset` resolves `"auto"` via
    `recommendedRoleCounts(playerCount)` (engine already imported
    client-side), not the hardcoded 1/0 fallbacks.
  - **Live tracking until touched**: while the host has not edited any role
    stepper this session AND the seeded `pendingRuleset.roles` values are
    `"auto"`, displayed counts recompute from `recommendedRoleCounts` as
    `playerCount` changes, and NO `set_ruleset` is broadcast (autos stay
    autos server-side). First stepper edit freezes ALL displayed counts to
    explicit numbers and broadcasts (current wire shape: explicit numbers +
    `villager: "auto"`). A reconnecting host who had edited sees their
    numbers (pendingRuleset seeds them — unchanged behavior).
  - A small "Reset to suggested" affordance (visible only when modified)
    that returns roles to all-auto (broadcasts an all-auto roles ruleset;
    `scenePhases` toggle must NOT be clobbered).
  - Hint line replaces the mafia-only suggestion with the full suggestion
    for current N, e.g. `Suggested for 16: 4 mafia · 1 minion ·
    3 detectives · 2 angels · 1 bomber · 5 villagers`. Never blocks.
- `src/client/screens/Lobby.tsx` `PendingRosterCard`: resolve `"auto"` roles
  via `recommendedRoleCounts(state.players.length)` (it currently assumes
  only villager can be auto; a fresh room now broadcasts all-auto).

## No protocol changes

`PendingRuleset` already types roles as `number | "auto"`. `set_ruleset` /
`start_game` shapes unchanged. Server code paths unchanged (game-room.ts
still writes engine `HOUSE_RULES` at claim; start still validates with
`validateRuleset`).

## Tests (land with the build)

- Engine unit (`test/engine/`): pin the exact reference table incl. small-N
  cases; property loop n=1..30 (invariants above); materialize: all-auto
  equals recommendation at N ∈ {5, 8, 16, 20}; explicit host override wins;
  villager remainder; mixed explicit+auto.
- Full-game scenarios at N=16 and N=20 (seeded, all-auto house rules):
  assigned role multiset matches the table; play a few phases; parity/win
  math sane (e.g. village win by eliminating mafia+minion still fires; no
  instant parity at start).
- Client: `countsFromRuleset`-level coverage of auto resolution (existing
  client test style).
- Existing suites must stay green; `FIVE_PLAYER_HOUSE_RULES` server fixture
  is already explicit and stays valid.
- E2E (targeted, orchestrator-run): host lobby with 5 tabs shows pre-filled
  suggested counts (2 mafia), villager remainder updates on stepper edit,
  Reset-to-suggested reappears autos, game starts and reaches night.

## Non-goals

Role packs; changing `validateRuleset` rules; changing wire shapes; balance
meter; 3rd detective / scaling beyond the confirmed table (host can dial).
