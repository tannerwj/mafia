import { describe, expect, test } from "vitest";
import { applyCommand, HOUSE_RULES, projectFor, startGame, validateRuleset, type GameState, type LobbyPlayer, type Ruleset } from "../../src/engine";
import { FIXTURE_ROLES } from "./fixtures/extra-roles";

const NOW = 1_000_000;
const players = (n: number): LobbyPlayer[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const rules = (roles: Record<string, number | "auto">, patch: Partial<Ruleset> = {}): Ruleset => ({
  ...HOUSE_RULES,
  roles,
  timers: {},
  ...patch,
});
const start = (n: number, ruleset: Ruleset, seed: number, now = NOW) => startGame(players(n), ruleset, seed, now, FIXTURE_ROLES).state;
const byRole = (state: GameState, roleId: string) => state.players.find((p) => p.roleId === roleId)!;
const living = (state: GameState) => state.players.filter((p) => p.alive);
const force = (state: GameState) => applyCommand(state, { type: "forceAdvance", byHost: true, gen: state.phaseGen }).state;
const toDay = (state: GameState) => {
  let s = state;
  if (s.phase === "night") s = force(s);
  if (s.phase === "dawn") s = force(s);
  return s;
};
const voteOut = (state: GameState, targetId: string) => {
  let s = state;
  for (const p of living(s)) s = applyCommand(s, { type: "castVote", playerId: p.id, target: targetId }).state;
  return s;
};

describe("engine core", () => {
  test("validates house rules semantics and timer floor", () => {
    const result = validateRuleset({ ...HOUSE_RULES, timers: { night: 4 } }, 5);
    expect(result.errors.map((e) => e.code)).toContain("timer_floor");
    expect(validateRuleset(HOUSE_RULES, 5).warnings.map((w) => w.code)).toContain("untimed");
  });

  test("same seed and commands produce identical state", () => {
    const r = rules({ mafia: 1, villager: 3, angel: 1 }, { firstNightKill: true });
    const a = start(5, r, 123);
    const b = start(5, r, 123);
    const mafia = byRole(a, "mafia");
    const target = a.players.find((p) => p.id !== mafia.id)!.id;
    const ar = applyCommand(a, { type: "submitAction", playerId: mafia.id, targetId: target });
    const br = applyCommand(b, { type: "submitAction", playerId: mafia.id, targetId: target });
    expect(ar).toEqual(br);
  });

  test("night kill, angel protection, detective result, and dawn reveal resolve through NAR", () => {
    let s = start(5, rules({ mafia: 1, villager: 2, angel: 1, detective: 1 }), 9);
    const mafia = byRole(s, "mafia");
    const angel = byRole(s, "angel");
    const detective = byRole(s, "detective");
    const target = s.players.find((p) => p.id !== mafia.id && p.id !== angel.id && p.id !== detective.id)!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: angel.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    expect(s.phase).toBe("dawn");
    expect(s.players.find((p) => p.id === target.id)?.alive).toBe(true);
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", outcome: "failed" }));
    expect(projectFor(s, { kind: "player", id: detective.id }).you?.investigationResults?.[0]).toMatchObject({ targetId: mafia.id, isMafia: true });
  });

  test("forceAdvance and timerExpired guards prevent double advancement", () => {
    const r = rules({ mafia: 1, villager: 2 }, { timers: { night: 5 } });
    let s = start(3, r, 1);
    s.deadlineAt = 1000;
    const staleTimer = applyCommand(s, { type: "timerExpired", at: 999 });
    expect(staleTimer.state).toBe(s);
    const advanced = applyCommand(s, { type: "forceAdvance", byHost: true, gen: s.phaseGen }).state;
    const staleForce = applyCommand(advanced, { type: "forceAdvance", byHost: true, gen: s.phaseGen });
    expect(staleForce.rejection?.code).toBe("stale_advance");
  });

  test("startGame with a configured night timer emits setDeadline at now+timer", () => {
    const r = rules({ mafia: 1, villager: 2 }, { timers: { night: 30 } });
    const result = startGame(players(3), r, 1, NOW, FIXTURE_ROLES);
    expect(result.effects).toContainEqual({ type: "setDeadline", at: NOW + 30_000 });
    expect(result.state.deadlineAt).toBe(NOW + 30_000);
  });

  test("plurality abstentions do not beat a single vote and no votes kill nobody", () => {
    let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 5));
    s = applyCommand(s, { type: "castVote", playerId: living(s)[0]!.id, target: living(s)[1]!.id }).state;
    s = force(s);
    expect(s.deaths.at(-1)?.cause).toBe("vote");
    let t = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 5));
    t = force(t);
    expect(t.deaths).toHaveLength(0);
  });

  test("majority threshold requires more than half of living players", () => {
    let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false, dayVoteThreshold: "majority" }), 3));
    const target = living(s)[0]!.id;
    s = applyCommand(s, { type: "castVote", playerId: living(s)[1]!.id, target }).state;
    s = applyCommand(s, { type: "castVote", playerId: living(s)[2]!.id, target }).state;
    s = force(s);
    expect(s.deaths).toHaveLength(0);
  });

  test("runoff pins exclude no_murder and tied runoff resolves to peace", () => {
    let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 7));
    const ids = living(s).map((p) => p.id);
    s = applyCommand(s, { type: "castVote", playerId: ids[0]!, target: ids[1]! }).state;
    s = applyCommand(s, { type: "castVote", playerId: ids[2]!, target: ids[3]! }).state;
    s = force(s);
    expect(s.phase).toBe("runoff");
    s = applyCommand(s, { type: "castVote", playerId: ids[0]!, target: ids[1]! }).state;
    s = applyCommand(s, { type: "castVote", playerId: ids[2]!, target: ids[3]! }).state;
    s = force(s);
    expect(s.deaths).toHaveLength(0);
    let t = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 7));
    const tid = living(t).map((p) => p.id);
    t = applyCommand(t, { type: "castVote", playerId: tid[0]!, target: tid[1]! }).state;
    t = applyCommand(t, { type: "castVote", playerId: tid[2]!, target: "no_murder" }).state;
    t = force(t);
    expect(t.phase).toBe("dusk");
    expect(t.deaths).toHaveLength(0);
  });

  test("other tie policies are deterministic and policy-specific", () => {
    const base = () => toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false, tiePolicy: "random" }), 7));
    const tied = (state: GameState) => {
      const ids = living(state).map((p) => p.id);
      let s = applyCommand(state, { type: "castVote", playerId: ids[0]!, target: ids[1]! }).state;
      s = applyCommand(s, { type: "castVote", playerId: ids[2]!, target: ids[3]! }).state;
      return force(s);
    };
    expect(tied(base())).toEqual(tied(base()));
    let killAll = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false, tiePolicy: "kill-all" }), 7));
    killAll = tied(killAll);
    expect(killAll.deaths.filter((d) => d.cause === "vote")).toHaveLength(2);
    let noMurder = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false, tiePolicy: "no-murder" }), 7));
    noMurder = tied(noMurder);
    expect(noMurder.deaths.filter((d) => d.cause === "vote")).toHaveLength(0);
  });

  test("mafia consensus modes and absent denominator use uniform plurality fallback", () => {
    let s = start(5, rules({ mafia: 2, villager: 3 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = force(s);
    expect(s.players.find((p) => p.id === target.id)?.alive).toBe(false);
    let t = start(5, rules({ mafia: 2, villager: 3 }, { mafiaConsensus: "unanimous" }), 1);
    const tm = t.players.filter((p) => p.roleId === "mafia");
    t = applyCommand(t, { type: "markAbsent", byHost: true, playerId: tm[1]!.id }).state;
    t = applyCommand(t, { type: "submitAction", playerId: tm[0]!.id, targetId: t.players.find((p) => p.roleId !== "mafia")!.id }).state;
    expect(t.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", outcome: "landed" }));
    let majority = start(5, rules({ mafia: 2, villager: 3 }, { mafiaConsensus: "majority" }), 3);
    const mm = majority.players.filter((p) => p.roleId === "mafia");
    const mt = majority.players.find((p) => p.roleId !== "mafia")!;
    majority = applyCommand(majority, { type: "submitAction", playerId: mm[0]!.id, targetId: mt.id }).state;
    majority = applyCommand(majority, { type: "submitAction", playerId: mm[1]!.id, targetId: mt.id }).state;
    expect(majority.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: mt.id }));
    let designated = start(4, rules({ mafia: 2, villager: 2 }, { mafiaConsensus: "designated" }), 4);
    const dm = designated.players.filter((p) => p.roleId === "mafia").sort((a, b) => a.seat - b.seat);
    const dt = designated.players.find((p) => p.roleId !== "mafia")!;
    designated = applyCommand(designated, { type: "submitAction", playerId: dm[0]!.id, targetId: dt.id }).state;
    expect(designated.phase).not.toBe("night");
  });

  test("unanimous consensus timeout resolves as plurality among submitted mafia votes", () => {
    let s = start(8, rules({ mafia: 3, villager: 5 }, { mafiaConsensus: "unanimous" }), 2);
    const mafia = s.players.filter((p) => p.roleId === "mafia").sort((a, b) => a.seat - b.seat);
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    const other = s.players.find((p) => p.roleId !== "mafia" && p.id !== target.id)!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[2]!.id, targetId: other.id }).state;
    s = force(s);
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: target.id, outcome: "landed" }));
    expect(s.log.filter((e) => e.type === "attackAttempted")).toHaveLength(1);
  });

  test("village must eliminate minions and minions can win parity", () => {
    let s = toDay(start(5, rules({ mafia: 1, minion: 1, villager: 3 }, { firstNightKill: false }), 2));
    s = voteOut(s, byRole(s, "mafia").id);
    expect(s.phase).not.toBe("ended");
    s = force(s);
    s = toDay(s);
    s = voteOut(s, living(s).find((p) => p.roleId === "villager")!.id);
    s = force(s);
    s = toDay(s);
    s = voteOut(s, living(s).find((p) => p.roleId === "villager")!.id);
    expect(s.phase).toBe("ended");
    expect(s.winners).toEqual(["mafia"]);
  });

  test("suicide bomber wins only by day vote, not night kill", () => {
    let s = toDay(start(5, rules({ mafia: 1, suicide_bomber: 1, villager: 3 }, { firstNightKill: false }), 8));
    s = voteOut(s, byRole(s, "suicide_bomber").id);
    expect(s.winners).toEqual(["suicide_bomber"]);
    let t = start(5, rules({ mafia: 1, suicide_bomber: 1, villager: 3 }), 8);
    t = applyCommand(t, { type: "submitAction", playerId: byRole(t, "mafia").id, targetId: byRole(t, "suicide_bomber").id }).state;
    expect(t.winners).not.toEqual(["suicide_bomber"]);
  });

  test("elimination anti-stall backstop fires after a no-death dawn cycle at parity", () => {
    let s = start(2, rules({ mafia: 1, villager: 1 }, { firstNightKill: false, parityRule: "elimination" }), 1);
    s = force(force(force(force(force(s)))));
    expect(s.phase).toBe("ended");
    expect(s.winners).toEqual(["mafia"]);
  });

  test("fixture Godfather fools detective, Jester wins, and Escort mutual-roleblock cancels blocks", () => {
    let s = start(4, rules({ godfather: 1, detective: 1, villager: 2 }), 4);
    s = applyCommand(s, { type: "submitAction", playerId: byRole(s, "detective").id, targetId: byRole(s, "godfather").id }).state;
    s = force(s);
    expect(s.investigationResults[0]?.isMafia).toBe(false);
    let j = toDay(start(4, rules({ mafia: 1, jester: 1, villager: 2 }, { firstNightKill: false }), 1));
    j = voteOut(j, byRole(j, "jester").id);
    expect(j.winners).toEqual(["jester"]);
    let e = start(4, rules({ escort: 2, mafia: 1, villager: 1 }), 11);
    const escorts = e.players.filter((p) => p.roleId === "escort");
    const mafia = byRole(e, "mafia");
    const target = byRole(e, "villager");
    e = applyCommand(e, { type: "submitAction", playerId: mafia.id, targetId: target.id }).state;
    e = applyCommand(e, { type: "submitAction", playerId: escorts[0]!.id, targetId: escorts[1]!.id }).state;
    e = applyCommand(e, { type: "submitAction", playerId: escorts[1]!.id, targetId: escorts[0]!.id }).state;
    e = force(e);
    expect(e.log.filter((x) => x.type === "attackAttempted")).toHaveLength(1);
  });

  test("projection privacy: living sees no roles, hidden votes suppress events, host sees pending, dead does not", () => {
    let s = start(5, rules({ mafia: 1, detective: 1, angel: 1, villager: 2 }), 9);
    const mafia = byRole(s, "mafia");
    const villager = byRole(s, "villager");
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: villager.id }).state;
    const livingView = projectFor(s, { kind: "player", id: villager.id });
    expect(livingView.players.some((p) => p.id !== villager.id && p.roleId)).toBe(false);
    expect(JSON.stringify(livingView)).not.toContain("pendingCount");
    expect(projectFor(s, { kind: "player", id: mafia.id }).you?.factionVotes).toEqual(expect.any(Array));
    expect(projectFor(s, { kind: "host" }).log.some((e) => e.type === "actionSubmitted")).toBe(true);
    const deadState = { ...s, players: s.players.map((p) => p.id === villager.id ? { ...p, alive: false } : p) };
    expect(projectFor(deadState, { kind: "player", id: villager.id }).log.some((e) => e.type === "actionSubmitted")).toBe(false);
  });

  test("re-projection includes own pending action", () => {
    let s = start(4, rules({ detective: 1, mafia: 1, villager: 2 }), 6);
    const detective = byRole(s, "detective");
    const target = byRole(s, "mafia");
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: target.id }).state;
    expect(projectFor(s, { kind: "player", id: detective.id }).you?.pendingAction).toMatchObject({ targetId: target.id });
  });

  test("firstNightKill=false: night 1 mafia kill is unavailable while detective and angel still act", () => {
    let s = start(5, rules({ mafia: 1, villager: 2, angel: 1, detective: 1 }, { firstNightKill: false }), 9);
    const mafia = byRole(s, "mafia");
    const angel = byRole(s, "angel");
    const detective = byRole(s, "detective");
    const target = s.players.find((p) => p.id !== mafia.id && p.id !== angel.id && p.id !== detective.id)!;
    const mafiaAttempt = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: target.id });
    expect(mafiaAttempt.rejection?.code).toBe("not_your_phase");
    s = applyCommand(s, { type: "submitAction", playerId: angel.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    expect(s.phase).toBe("dawn");
    expect(s.log.some((e) => e.type === "attackAttempted")).toBe(false);
    expect(projectFor(s, { kind: "player", id: detective.id }).you?.investigationResults?.[0]).toMatchObject({ targetId: mafia.id, isMafia: true });
  });

  test("timerExpired applies defaults: unsubmitted night actions no-op, unvoted players abstain, nobody dies", () => {
    let s = start(5, rules({ mafia: 1, villager: 2, angel: 1, detective: 1 }), 9);
    const before = s.deadlineAt;
    void before;
    s.deadlineAt = NOW + 1000;
    s = applyCommand(s, { type: "timerExpired", at: NOW + 1000, now: NOW + 1000 }).state;
    expect(s.phase).toBe("dawn");
    expect(s.deaths).toHaveLength(0);
    expect(s.log.some((e) => e.type === "attackAttempted")).toBe(false);
    let day = toDay(s);
    day.deadlineAt = NOW + 2000;
    day = applyCommand(day, { type: "timerExpired", at: NOW + 2000, now: NOW + 2000 }).state;
    expect(day.phase).toBe("dusk");
    expect(day.deaths).toHaveLength(0);
  });

  test("forceAdvance mid-night applies the same defaults, including mafia plurality-of-submitted", () => {
    let s = start(8, rules({ mafia: 2, villager: 6 }, { mafiaConsensus: "unanimous" }), 2);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = force(s);
    expect(s.phase).toBe("dawn");
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: target.id, outcome: "landed" }));
    let t = start(8, rules({ mafia: 2, villager: 6 }, { mafiaConsensus: "unanimous" }), 2);
    t = force(t);
    expect(t.phase).toBe("dawn");
    expect(t.log.some((e) => e.type === "attackAttempted")).toBe(false);
    expect(t.deaths).toHaveLength(0);
  });

  test("markAbsent on the sole pending actor triggers immediate zero-pending advance", () => {
    let s = start(3, rules({ detective: 1, mafia: 1, villager: 1 }, { firstNightKill: false }), 6);
    const detective = byRole(s, "detective");
    expect(s.phase).toBe("night");
    s = applyCommand(s, { type: "markAbsent", byHost: true, playerId: detective.id }).state;
    expect(s.phase).toBe("dawn");
  });

  test("dawn and dusk beats emit setDeadline effects using dawnDuskBeatMs", () => {
    const r = rules({ mafia: 1, detective: 1, villager: 2 }, { firstNightKill: false, dawnDuskBeatMs: 4242 });
    let s = start(4, r, 5);
    expect(s.phase).toBe("night");
    const advance = applyCommand(s, { type: "forceAdvance", byHost: true, gen: s.phaseGen, now: NOW + 10 });
    expect(advance.state.phase).toBe("dawn");
    expect(advance.effects).toContainEqual({ type: "setDeadline", at: NOW + 10 + 4242 });
    const toDayState = applyCommand(advance.state, { type: "forceAdvance", byHost: true, gen: advance.state.phaseGen, now: NOW + 15 });
    expect(toDayState.state.phase).toBe("day");
    const duskAdvance = applyCommand(toDayState.state, { type: "forceAdvance", byHost: true, gen: toDayState.state.phaseGen, now: NOW + 20 });
    expect(duskAdvance.state.phase).toBe("dusk");
    expect(duskAdvance.effects).toContainEqual({ type: "setDeadline", at: NOW + 20 + 4242 });
  });

  test("projection: living player's night view has no pending-count field, and player order is join order throughout a scripted game", () => {
    let s = start(5, rules({ mafia: 1, detective: 1, angel: 1, villager: 2 }), 9);
    const joinOrder = players(5).map((p) => p.id);
    const expectJoinOrder = (state: GameState, viewer: { kind: "player"; id: string } | { kind: "host" } | { kind: "public" }) => {
      const view = projectFor(state, viewer);
      expect(view.players.map((p) => p.id)).toEqual(joinOrder);
    };
    const villager = byRole(s, "villager");
    const livingNightView = projectFor(s, { kind: "player", id: villager.id });
    expect(livingNightView).not.toHaveProperty("pendingCount");
    expect(livingNightView.you).not.toHaveProperty("pendingCount");
    expect(JSON.stringify(livingNightView)).not.toMatch(/pending.*count/i);
    expectJoinOrder(s, { kind: "player", id: villager.id });
    expectJoinOrder(s, { kind: "host" });

    const mafia = byRole(s, "mafia");
    const angel = byRole(s, "angel");
    const detective = byRole(s, "detective");
    const target = s.players.find((p) => p.id !== mafia.id && p.id !== angel.id && p.id !== detective.id)!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: angel.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    expect(s.phase).toBe("dawn");
    expectJoinOrder(s, { kind: "player", id: villager.id });
    s = force(s);
    expect(s.phase).toBe("day");
    expectJoinOrder(s, { kind: "player", id: villager.id });
    s = voteOut(s, mafia.id);
    expectJoinOrder(s, { kind: "player", id: villager.id });
    expectJoinOrder(s, { kind: "public" });
  });
});
