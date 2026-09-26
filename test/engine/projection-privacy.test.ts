import { describe, expect, test } from "vitest";
import { HOUSE_RULES, projectFor, startGame, type GameState, type LobbyPlayer, type Ruleset } from "../../src/engine";
import type { GameEvent } from "../../src/shared/game-view";

const PLAYERS: LobbyPlayer[] = [
  { id: "p1", name: "Alice" },
  { id: "p2", name: "Bob" },
  { id: "p3", name: "Carol" },
  { id: "p4", name: "Dave" },
  { id: "p5", name: "Erin" },
];

function baseState(patch: Partial<Ruleset> = {}): GameState {
  const ruleset: Ruleset = {
    ...HOUSE_RULES,
    roles: { mafia: 1, detective: 1, angel: 1, villager: 2 },
    timers: {},
    ...patch,
  };
  return startGame(PLAYERS, ruleset, 7, 1_000).state;
}

function eventTypes(events: GameEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("Spec 19 projection privacy", () => {
  test("living and public logs are an explicit safe allowlist and expose unique failed days", () => {
    const state = baseState();
    const death = state.players[2]!;
    state.log = [
      { type: "gameStarted", roleAssignments: state.players.map((p) => ({ playerId: p.id, roleId: p.roleId })) },
      { type: "futureSecret", playerId: "p1", targetId: "p2" } as unknown as GameEvent,
      { type: "phaseChanged", phase: "night", day: 1, phaseGen: 0 },
      { type: "actionSubmitted", actorId: "p1", actionType: "watch", targetId: "p2", day: 1 },
      { type: "actionLocked", actorId: "p1", day: 1 },
      { type: "attackAttempted", day: 3, actorId: "p1", targetId: "p2", attack: "basic", defense: "powerful", outcome: "failed" },
      { type: "attackAttempted", day: 1, actorId: "p1", targetId: "p2", attack: "basic", defense: "powerful", outcome: "failed" },
      { type: "attackAttempted", day: 3, actorId: "p4", targetId: "p5", attack: "basic", defense: "powerful", outcome: "failed" },
      { type: "investigationResult", day: 1, actorId: "p2", targetId: "p1", isMafia: true },
      { type: "voteCast", voterId: "p1", target: "p2", day: 1, phase: "day" },
      { type: "playerDied", playerId: death.id, roleId: death.roleId, cause: "night", day: 1 },
      { type: "runoffStarted", candidates: ["p1", "p2"], day: 1 },
      { type: "voteResolved", eliminatedId: null, day: 1, reason: "no_murder" },
      { type: "playerAbsent", playerId: "p5" },
      { type: "playerPresent", playerId: "p5" },
      { type: "gameEnded", winners: ["village"], reason: "test" },
    ];

    const publicView = projectFor(state, { kind: "public" });
    const livingView = projectFor(state, { kind: "player", id: "p1" });
    const safeTypes = new Set(["phaseChanged", "runoffStarted", "voteResolved", "playerAbsent", "playerPresent", "gameEnded", "playerDied"]);

    for (const view of [publicView, livingView]) {
      expect(view.log.every((event) => safeTypes.has(event.type))).toBe(true);
      expect(eventTypes(view.log)).not.toContain("gameStarted");
      expect(eventTypes(view.log)).not.toContain("attackAttempted");
      expect(eventTypes(view.log)).not.toContain("investigationResult");
      expect(eventTypes(view.log)).not.toContain("actionSubmitted");
      expect(eventTypes(view.log)).not.toContain("actionLocked");
      expect(eventTypes(view.log)).not.toContain("voteCast");
      expect(eventTypes(view.log)).not.toContain("futureSecret");
      expect(eventTypes(view.log)).not.toContain("acknowledged");
      expect((view as ClientGameViewWithPrivacy).attackFailedDays).toEqual([1, 3]);
    }
  });

  test("dead players see resolved history and roles, but never live submissions or hidden ballots", () => {
    const state = baseState();
    const dead = state.players[0]!;
    dead.alive = false;
    dead.roleId = "villager";
    state.log = [
      { type: "gameStarted", roleAssignments: state.players.map((p) => ({ playerId: p.id, roleId: p.roleId })) },
      { type: "futureSecret", playerId: "p1", targetId: "p2" } as unknown as GameEvent,
      { type: "actionSubmitted", actorId: "p2", actionType: "investigate", targetId: "p3", day: 1 },
      { type: "actionLocked", actorId: "p2", day: 1 },
      { type: "actionUnlocked", actorId: "p2", day: 1 },
      { type: "voteCast", voterId: "p2", target: "p3", day: 1, phase: "day" },
      { type: "voteRetracted", voterId: "p2", day: 1, phase: "day" },
      { type: "voteLocked", voterId: "p2", day: 1, phase: "day" },
      { type: "voteUnlocked", voterId: "p2", day: 1, phase: "day" },
      { type: "attackAttempted", day: 1, actorId: "p2", targetId: "p3", attack: "basic", defense: "powerful", outcome: "failed" },
      { type: "investigationResult", day: 1, actorId: "p2", targetId: "p3", isMafia: false },
      { type: "playerDied", playerId: "p3", roleId: "villager", cause: "night", day: 1 },
      { type: "voteResolved", eliminatedId: null, day: 1, reason: "no_murder" },
      { type: "acknowledged", playerId: "p2", day: 1 },
    ];
    state.nightActions = [{ actorId: dead.id, actionType: "watch", targetId: "p2", locked: true }];
    state.mafiaVotes = [{ playerId: dead.id, targetId: "p2", locked: true }];
    state.votes = [{ playerId: "p2", target: "p3", locked: true }];

    const view = projectFor(state, { kind: "player", id: dead.id });
    expect(view.players.every((player) => player.roleId !== undefined)).toBe(true);
    expect(eventTypes(view.log)).toEqual(expect.arrayContaining(["gameStarted", "attackAttempted", "investigationResult", "playerDied", "voteResolved"]));
    for (const type of [
      "actionSubmitted",
      "actionLocked",
      "actionUnlocked",
      "voteCast",
      "voteRetracted",
      "voteLocked",
      "voteUnlocked",
      "acknowledged",
      "futureSecret",
    ]) {
      expect(eventTypes(view.log)).not.toContain(type);
    }
    expect(view.votes).toBeUndefined();
    expect(view.you).not.toHaveProperty("pendingAction");
    expect(view.you).not.toHaveProperty("nightActionLocked");
    expect(view.you).not.toHaveProperty("currentVote");
    expect(view.you).not.toHaveProperty("dayVoteLocked");

    // A stale persisted ballot must stay private after resolution phases too.
    // Only the host (or an explicitly realtime ruleset) may receive ballots.
    for (const phase of ["dusk", "ended"] as const) {
      state.phase = phase;
      expect(projectFor(state, { kind: "public" }).votes).toBeUndefined();
      expect(projectFor(state, { kind: "player", id: dead.id }).votes).toBeUndefined();
      expect(projectFor(state, { kind: "host" }).votes).toEqual([
        { playerId: "p2", target: "p3", locked: true },
      ]);
    }
  });

  test("playerDied log disclosure follows the configured reveal mode while graveyard stays authoritative", () => {
    for (const revealOnDeath of ["full", "alignment", "none"] as const) {
      const state = baseState({ revealOnDeath });
      const victim = state.players[1]!;
      victim.alive = false;
      state.deaths = [{ playerId: victim.id, roleId: victim.roleId, alignment: "town", day: 1, phase: "night", cause: "night" }];
      state.log = [{ type: "playerDied", playerId: victim.id, roleId: victim.roleId, cause: "night", day: 1 }];

      const view = projectFor(state, { kind: "player", id: state.players[0]!.id });
      const grave = view.graveyard.find((entry) => entry.playerId === victim.id)!;
      expect(view.log.some((event) => event.type === "playerDied")).toBe(revealOnDeath === "full");
      if (revealOnDeath === "full") expect(grave.roleId).toBe(victim.roleId);
      if (revealOnDeath === "alignment") {
        expect(grave.roleId).toBeUndefined();
        expect(grave.alignment).toBe("town");
      }
      if (revealOnDeath === "none") {
        expect(grave.roleId).toBeUndefined();
        expect(grave.alignment).toBeUndefined();
      }
    }
  });
});

type ClientGameViewWithPrivacy = ReturnType<typeof projectFor> & { attackFailedDays: number[] };
