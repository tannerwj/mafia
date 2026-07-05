// Client-local mirror of `src/engine/ruleset.ts`'s `HOUSE_RULES` shape — NOT
// an import from `src/engine` (this spec is client-only). The host-only
// "Start game" trigger in Lobby.tsx needs *some* ruleset to send, and a full
// ruleset editor is Spec 06's job — this is the minimum functional hook
// needed for D4's Playwright suite (and any manual host testing before
// Spec 05 ships a real configuration screen) to start a game at all. The
// server is authoritative and re-validates whatever ruleset arrives
// (`invalid_ruleset` on the `error` channel) — this object carries no
// game logic, it's just a wire payload literal.
export const HOUSE_RULESET = {
  roles: {
    mafia: "auto",
    villager: "auto",
    detective: 1,
    angel: 1,
    suicide_bomber: 1,
    minion: 0,
  },
  mafiaCountFormula: "sqrt",
  firstNightKill: true,
  tiePolicy: "runoff-then-peace",
  dayVoteThreshold: "plurality",
  noMurderOption: true,
  mafiaConsensus: "unanimous",
  revealOnDeath: "full",
  parityRule: "immediate",
  votingVisibility: "hidden",
  timers: {},
  dawnDuskBeatMs: 3000,
} as const;

/** Test-only hook (mirrors Spec 03's `ALLOW_TEST_SEED` dev/test gate): a
 * Playwright test can stash a numeric seed in sessionStorage before
 * clicking "Start game" so `start_game.seed` is deterministic. The server
 * silently ignores `seed` unless its own `ALLOW_TEST_SEED` env is set, so
 * this is inert in production regardless of what's in sessionStorage. */
export function testSeedOverride(): number | undefined {
  const raw = sessionStorage.getItem("mafia:testSeed");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Test-only hook, same shape/gating as `testSeedOverride`: `HOUSE_RULESET`
 * hardcodes `minion: 0` (no host UI exists yet to configure roles — Spec
 * 06's job), so a minion is unreachable through the real client flow. A
 * Playwright test can stash a JSON-encoded role-count patch (e.g.
 * `{"minion":1,"villager":0}`) to reach a minion viewer for the
 * `you.mafiaRoster` assertion. The server re-validates whatever ruleset
 * arrives regardless (`invalid_ruleset` on the `error` channel) — this is
 * a wire payload override, not new game logic. */
export function testRolesOverride(): Partial<typeof HOUSE_RULESET.roles> | undefined {
  const raw = sessionStorage.getItem("mafia:testRoles");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
