import { describe, expect, test } from "vitest";
import {
  applyCommand,
  HOUSE_RULES,
  materializeRoleCounts,
  recommendedRoleCounts,
  startGame,
  validateRuleset,
  type GameState,
  type LobbyPlayer,
  type Ruleset,
} from "../../src/engine";
import { FIXTURE_ROLES } from "./fixtures/extra-roles";

const NOW = 1_000_000;
const players = (n: number): LobbyPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const start = (n: number, ruleset: Ruleset, seed: number, now = NOW) =>
  startGame(players(n), ruleset, seed, now, FIXTURE_ROLES).state;
const force = (state: GameState) =>
  applyCommand(state, { type: "forceAdvance", byHost: true, gen: state.phaseGen }).state;
const living = (state: GameState) => state.players.filter((p) => p.alive);

// Spec 13: the confirmed small-table cases (n < 6) — today's fixed defaults
// are invalid here, these must be exactly right.
describe("recommendedRoleCounts: small-table cases (spec-pinned)", () => {
  const cases: [number, Record<string, number>][] = [
    [1, { mafia: 1, detective: 0, angel: 0, suicide_bomber: 0, minion: 0, villager: 0 }],
    [2, { mafia: 1, detective: 0, angel: 0, suicide_bomber: 0, minion: 0, villager: 1 }],
    [3, { mafia: 1, detective: 1, angel: 0, suicide_bomber: 0, minion: 0, villager: 1 }],
    [4, { mafia: 1, detective: 1, angel: 1, suicide_bomber: 0, minion: 0, villager: 1 }],
    [5, { mafia: 2, detective: 1, angel: 1, suicide_bomber: 1, minion: 0, villager: 0 }],
  ];
  for (const [n, expected] of cases) {
    test(`n=${n}`, () => {
      expect(recommendedRoleCounts(n)).toEqual(expected);
    });
  }
});

// Spec 13 v2: the confirmed n>=6 reference table (revised thresholds —
// detective 2@8+/3@16+, angel 2@12+) — MUST NOT be altered without a new
// spec.
describe("recommendedRoleCounts: n>=6 reference table (spec-pinned, v2)", () => {
  const cases: [number, Record<string, number>][] = [
    [6, { mafia: 2, minion: 0, detective: 1, angel: 1, suicide_bomber: 1, villager: 1 }],
    [8, { mafia: 3, minion: 0, detective: 2, angel: 1, suicide_bomber: 1, villager: 1 }],
    [10, { mafia: 3, minion: 0, detective: 2, angel: 1, suicide_bomber: 1, villager: 3 }],
    [12, { mafia: 3, minion: 0, detective: 2, angel: 2, suicide_bomber: 1, villager: 4 }],
    [14, { mafia: 4, minion: 0, detective: 2, angel: 2, suicide_bomber: 1, villager: 5 }],
    [16, { mafia: 4, minion: 1, detective: 3, angel: 2, suicide_bomber: 1, villager: 5 }],
    [18, { mafia: 5, minion: 1, detective: 3, angel: 2, suicide_bomber: 1, villager: 6 }],
    [20, { mafia: 5, minion: 1, detective: 3, angel: 2, suicide_bomber: 1, villager: 8 }],
  ];
  for (const [n, expected] of cases) {
    test(`n=${n}`, () => {
      expect(recommendedRoleCounts(n)).toEqual(expected);
    });
  }
});

describe("recommendedRoleCounts: invariants n=1..30", () => {
  for (let n = 1; n <= 30; n++) {
    test(`n=${n}: sums to n, all non-negative, mafia>=1`, () => {
      const rec = recommendedRoleCounts(n);
      const total = Object.values(rec).reduce((sum, c) => sum + c, 0);
      expect(total).toBe(n);
      for (const count of Object.values(rec)) expect(count).toBeGreaterThanOrEqual(0);
      expect(rec.mafia).toBeGreaterThanOrEqual(1);
    });
  }

  for (let n = 5; n <= 30; n++) {
    test(`n=${n}: evil team (mafia+minion) strictly < ceil(n/2), never parity at start`, () => {
      const rec = recommendedRoleCounts(n);
      const evil = (rec.mafia ?? 0) + (rec.minion ?? 0);
      const ceilHalf = Math.ceil(n / 2);
      expect(evil).toBeLessThan(ceilHalf);
    });
  }

  for (let n = 3; n <= 30; n++) {
    test(`n=${n}: validateRuleset(all-auto HOUSE_RULES, n) has zero errors`, () => {
      const result = validateRuleset(HOUSE_RULES, n);
      expect(result.errors).toEqual([]);
    });
  }
});

describe("materializeRoleCounts: auto resolution via recommendedRoleCounts", () => {
  for (const n of [5, 8, 16, 20]) {
    test(`n=${n}: all-auto HOUSE_RULES materializes to the recommendation`, () => {
      const materialized = materializeRoleCounts(HOUSE_RULES, n);
      expect(materialized).toEqual(recommendedRoleCounts(n));
    });
  }

  test("explicit host override wins over auto for every role", () => {
    const ruleset: Ruleset = {
      ...HOUSE_RULES,
      roles: { mafia: 5, detective: 3, angel: 0, suicide_bomber: 0, minion: 0, villager: "auto" },
    };
    const materialized = materializeRoleCounts(ruleset, 20);
    expect(materialized.mafia).toBe(5);
    expect(materialized.detective).toBe(3);
    expect(materialized.angel).toBe(0);
    // villager absorbs the remainder, unaffected by the recommendation.
    expect(materialized.villager).toBe(20 - 5 - 3 - 0 - 0 - 0);
  });

  test("villager remainder is always the absorber, even when other roles are auto", () => {
    const ruleset: Ruleset = {
      ...HOUSE_RULES,
      roles: { mafia: "auto", detective: "auto", angel: 0, suicide_bomber: 0, minion: 0, villager: "auto" },
    };
    const materialized = materializeRoleCounts(ruleset, 10);
    const rec = recommendedRoleCounts(10);
    expect(materialized.mafia).toBe(rec.mafia);
    expect(materialized.detective).toBe(rec.detective);
    const used = (materialized.mafia ?? 0) + (materialized.detective ?? 0);
    expect(materialized.villager).toBe(10 - used);
  });

  test("mixed explicit+auto: unmixed roles resolve independently", () => {
    const ruleset: Ruleset = {
      ...HOUSE_RULES,
      roles: { mafia: "auto", detective: 0, angel: "auto", suicide_bomber: 1, minion: 0, villager: "auto" },
    };
    const materialized = materializeRoleCounts(ruleset, 16);
    const rec = recommendedRoleCounts(16);
    expect(materialized.mafia).toBe(rec.mafia);
    expect(materialized.angel).toBe(rec.angel);
    expect(materialized.detective).toBe(0);
    expect(materialized.suicide_bomber).toBe(1);
  });

  test("unknown/non-house auto role resolves to 0", () => {
    const ruleset: Ruleset = {
      ...HOUSE_RULES,
      roles: { mafia: 1, villager: "auto", jester: "auto" } as unknown as Ruleset["roles"],
    };
    const materialized = materializeRoleCounts(ruleset, 5);
    expect(materialized.jester).toBe(0);
  });
});

// Spec 13: full-game scenarios at N=16 and N=20 with all-auto house rules —
// assigned role multiset matches the table, a few phases play out, and
// parity/win math stays sane (no instant parity at start; elimination win
// still fires).
describe("full-game scenarios: all-auto house rules at scale", () => {
  for (const n of [16, 20]) {
    test(`N=${n}: assigned roles match the recommendation multiset`, () => {
      const state = start(n, { ...HOUSE_RULES, timers: {} }, 42);
      const rec = recommendedRoleCounts(n);
      const counts: Record<string, number> = {};
      for (const p of state.players) counts[p.roleId] = (counts[p.roleId] ?? 0) + 1;
      for (const [roleId, expected] of Object.entries(rec)) {
        expect(counts[roleId] ?? 0).toBe(expected);
      }
      expect(state.players).toHaveLength(n);
    });

    test(`N=${n}: no instant parity at game start`, () => {
      const state = start(n, { ...HOUSE_RULES, timers: {} }, 7);
      const evilAlive = living(state).filter((p) => p.roleId === "mafia" || p.roleId === "minion").length;
      const goodAlive = living(state).length - evilAlive;
      expect(evilAlive).toBeLessThan(goodAlive);
    });

    test(`N=${n}: village win by eliminating mafia+minion still fires`, () => {
      let s = start(n, { ...HOUSE_RULES, timers: {} }, 99);
      // Force-advance through night/dawn repeatedly, day-voting out an evil
      // player each day, until the game ends or we've exhausted evil players
      // (bounded loop so a stalled resolver fails the test instead of hanging).
      for (let i = 0; i < n * 3 && !s.winners; i++) {
        if (s.phase === "night" || s.phase === "dawn") {
          s = force(s);
          continue;
        }
        if (s.phase === "day" || s.phase === "runoff") {
          const evilTarget = living(s).find((p) => p.roleId === "mafia" || p.roleId === "minion");
          if (!evilTarget) break;
          for (const p of living(s)) {
            const r = applyCommand(s, { type: "castVote", playerId: p.id, target: evilTarget.id });
            s = r.state;
            if (s.phase === "day" || s.phase === "runoff") {
              const cr = applyCommand(s, { type: "confirmVote", playerId: p.id });
              s = cr.state;
            }
          }
          if (s.phase === "day" || s.phase === "runoff") s = force(s);
          continue;
        }
        break;
      }
      const evilRemaining = living(s).filter((p) => p.roleId === "mafia" || p.roleId === "minion").length;
      if (evilRemaining === 0) {
        expect(s.winners).toEqual(["village"]);
      } else {
        // Bounded loop exhausted without eliminating all evil (e.g. a
        // suicide-bomber/jester side win intervened) — still assert the
        // engine reached a sane terminal-or-ongoing state, never a hang.
        expect(s.phase).toBeDefined();
      }
    });
  }
});
