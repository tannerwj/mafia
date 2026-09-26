import { describe, expect, test } from "vitest";
import { resolveConsensus, resolveLockedPlurality } from "../../src/engine/consensus";
import {
  applyCommand,
  HOUSE_RULES,
  startGame,
  validateRuleset,
  type GameState,
  type LobbyPlayer,
  type Ruleset,
} from "../../src/engine";
import type { MafiaVote, PlayerState } from "../../src/engine/types";
import { FIXTURE_ROLES } from "./fixtures/extra-roles";

const player = (id: string, seat: number, roleId = "mafia"): PlayerState => ({
  id,
  seat,
  roleId,
  alive: true,
  absent: false,
});

const killers = [player("killer-0", 0), player("killer-1", 1)];

const lockedVote = (playerId: string, targetId: string): MafiaVote => ({
  playerId,
  targetId,
  locked: true,
});

describe("Spec 22: deterministic mafia tie breaks", () => {
  test("majority target ties use the lowest supporting killer seat, regardless of arrival order", () => {
    const firstArrival = resolveConsensus(
      [lockedVote("killer-1", "target-seat-2"), lockedVote("killer-0", "target-seat-4")],
      killers,
      "majority",
      { lockedOnly: true },
    );
    const reversedArrival = resolveConsensus(
      [lockedVote("killer-0", "target-seat-4"), lockedVote("killer-1", "target-seat-2")],
      killers,
      "majority",
      { lockedOnly: true },
    );

    const expected = { actorId: "killer-0", targetId: "target-seat-4" };
    expect(firstArrival.target).toEqual(expected);
    expect(reversedArrival.target).toEqual(expected);
  });

  test("locked-plurality fallback uses the same supporting-killer seat rule", () => {
    const firstArrival = resolveLockedPlurality(
      [lockedVote("killer-1", "target-seat-2"), lockedVote("killer-0", "target-seat-4")],
      killers,
    );
    const reversedArrival = resolveLockedPlurality(
      [lockedVote("killer-0", "target-seat-4"), lockedVote("killer-1", "target-seat-2")],
      killers,
    );

    const expected = { actorId: "killer-0", targetId: "target-seat-4" };
    expect(firstArrival).toEqual(expected);
    expect(reversedArrival).toEqual(expected);
  });

  test("a winning target's actor is the lowest-seat supporting killer", () => {
    const threeKillers = [...killers, player("killer-2", 2)];
    const firstArrival = resolveConsensus(
      [lockedVote("killer-1", "target"), lockedVote("killer-0", "target"), lockedVote("killer-2", "other")],
      threeKillers,
      "majority",
      { lockedOnly: true },
    );
    const reversedArrival = resolveConsensus(
      [lockedVote("killer-0", "target"), lockedVote("killer-1", "target"), lockedVote("killer-2", "other")],
      threeKillers,
      "majority",
      { lockedOnly: true },
    );

    expect(firstArrival.target).toEqual({ actorId: "killer-0", targetId: "target" });
    expect(reversedArrival.target).toEqual({ actorId: "killer-0", targetId: "target" });
  });

  test("unanimous consensus keeps its target but returns a deterministic actor", () => {
    const result = resolveConsensus(
      [lockedVote("killer-1", "target"), lockedVote("killer-0", "target")],
      killers,
      "unanimous",
      { lockedOnly: true },
    );

    expect(result.target).toEqual({ actorId: "killer-0", targetId: "target" });
  });
});

const randomPlayers = (count: number): LobbyPlayer[] =>
  Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}`, name: `P${index + 1}` }));

const randomRuleset: Ruleset = {
  ...HOUSE_RULES,
  roles: { mafia: 1, villager: 4 },
  firstNightKill: false,
  tiePolicy: "random",
  noMurderOption: false,
  timers: {},
};

function resolveRandomTie(order: { voter: string; target: string }[]): GameState {
  let state = startGame(randomPlayers(5), randomRuleset, 123, 1_000_000, FIXTURE_ROLES).state;
  state = applyCommand(state, { type: "forceAdvance", byHost: true, gen: state.phaseGen }).state;
  state = applyCommand(state, { type: "forceAdvance", byHost: true, gen: state.phaseGen }).state;
  for (const ballot of order) {
    state = applyCommand(state, { type: "castVote", playerId: ballot.voter, target: ballot.target }).state;
    state = applyCommand(state, { type: "confirmVote", playerId: ballot.voter }).state;
  }
  return applyCommand(state, { type: "forceAdvance", byHost: true, gen: state.phaseGen }).state;
}

describe("Spec 22: seeded random day ties", () => {
  test("identical tied ballots choose the same victim regardless of arrival order", () => {
    const ballots = [
      { voter: "p1", target: "p4" },
      { voter: "p2", target: "p4" },
      { voter: "p3", target: "p5" },
      { voter: "p4", target: "p5" },
    ];
    const firstArrival = resolveRandomTie(ballots);
    const reversedArrival = resolveRandomTie([...ballots].reverse());
    const eliminated = (state: GameState) => state.deaths.find((death) => death.cause === "vote")?.playerId;

    expect(eliminated(firstArrival)).toBe(eliminated(reversedArrival));
    expect(eliminated(firstArrival)).toEqual(expect.stringMatching(/^p[45]$/));
  });
});

const validExplicitRuleset: Ruleset = {
  ...HOUSE_RULES,
  roles: { mafia: 1, villager: 2, detective: 0, angel: 0, suicide_bomber: 0, minion: 0 },
  timers: {},
};

describe("Spec 22: runtime ruleset validation", () => {
  test.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
    ["string", "1"],
    ["boolean", true],
    ["omitted", undefined],
  ])("rejects %s explicit role counts with a role-specific error", (_label, value) => {
    const ruleset = {
      ...validExplicitRuleset,
      roles: { ...validExplicitRuleset.roles, detective: value },
    } as unknown as Ruleset;

    const result = validateRuleset(ruleset, 3);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "role_count_invalid",
          message: expect.stringContaining("detective"),
        }),
      ]),
    );
  });

  test("keeps valid integer counts valid", () => {
    expect(validateRuleset(validExplicitRuleset, 3).errors).toEqual([]);
  });

  test.each([
    ["missing roles", { ...validExplicitRuleset, roles: undefined }],
    ["null roles", { ...validExplicitRuleset, roles: null }],
    ["array roles", { ...validExplicitRuleset, roles: [] }],
    ["missing timers", { ...validExplicitRuleset, timers: undefined }],
    ["null timers", { ...validExplicitRuleset, timers: null }],
    ["array timers", { ...validExplicitRuleset, timers: [] }],
    ["missing parity rule", { ...validExplicitRuleset, parityRule: undefined }],
    ["missing dawn beat", { ...validExplicitRuleset, dawnDuskBeatMs: undefined }],
  ])("rejects %s without throwing", (_label, ruleset) => {
    expect(() => validateRuleset(ruleset as unknown as Ruleset, 3)).not.toThrow();
    const result = validateRuleset(ruleset as unknown as Ruleset, 3);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ruleset_shape_invalid" })]));
  });
});
