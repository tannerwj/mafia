import { describe, expect, test } from "vitest";
import { applyCommand, HOUSE_RULES, narratorBoardHistory, projectFor, startGame, validateRuleset, type GameState, type LobbyPlayer, type Ruleset } from "../../src/engine";
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
// Spec 11: every living non-absent, non-mafia player owes an individual night
// input now (real action or the inert decoy "watch"). This helper settles all
// of them — for anyone who hasn't already submitted, it picks a live decoy
// target and locks; for anyone who submitted but hasn't locked, it locks. It
// leaves the mafia-consensus vote to the caller (mafia readiness is a separate
// gate). Use it in tests that only drove the "real" actors but still expect
// the night to resolve naturally.
const settleDecoys = (state: GameState, exclude: string[] = []) => {
  let s = state;
  // A player is a mafia-consensus killer this night (settled by the caller,
  // not here) iff their role kills AND the kill isn't suppressed on a
  // firstNightKill=false night 1. On such a night 1 the mafia falls through to
  // the decoy and IS settled here.
  const killsThisNight = (roleId: string) =>
    (roleId === "mafia" || roleId === "godfather") && !(s.ruleset.firstNightKill === false && s.day === 1);
  for (const p of s.players) {
    if (!p.alive || p.absent || exclude.includes(p.id)) continue;
    if (killsThisNight(p.roleId)) continue; // mafia consensus is the caller's job
    const existing = s.nightActions.find((a) => a.actorId === p.id);
    if (!existing) {
      const target = s.players.find((q) => q.alive && q.id !== p.id);
      const sub = applyCommand(s, { type: "submitAction", playerId: p.id, targetId: target ? target.id : null });
      // A role with no legal individual input in this phase (rejected) is
      // skipped — it isn't part of the readiness set.
      if (!sub.rejection) s = sub.state;
      else continue;
    }
    if (s.phase === "night") {
      const lock = applyCommand(s, { type: "lockAction", playerId: p.id });
      if (!lock.rejection) s = lock.state;
    }
  }
  return s;
};
// Spec 11: cast + confirm a single day vote (the confirm is what makes it
// count on a forced/timer resolution — an unconfirmed vote abstains).
const castConfirm = (state: GameState, playerId: string, target: string) => {
  let s = applyCommand(state, { type: "castVote", playerId, target }).state;
  s = applyCommand(s, { type: "confirmVote", playerId }).state;
  return s;
};
const toDay = (state: GameState) => {
  let s = state;
  if (s.phase === "night") s = force(s);
  if (s.phase === "dawn") s = force(s);
  return s;
};
// Spec 11: a day vote now needs cast + confirm from every living player before
// the phase resolves naturally.
const voteOut = (state: GameState, targetId: string) => {
  let s = state;
  for (const p of living(s)) {
    s = applyCommand(s, { type: "castVote", playerId: p.id, target: targetId }).state;
    if (s.phase === "day" || s.phase === "runoff") {
      s = applyCommand(s, { type: "confirmVote", playerId: p.id }).state;
    }
  }
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
    // Spec 08: the night's mafia-kill readiness gate is "locked", not
    // "submitted". Spec 11: individual actors (angel, detective) confirm
    // (lock) too, and the villagers owe a decoy — settleDecoys drives all
    // remaining living non-mafia inputs so the night resolves naturally.
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: angel.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: angel.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: detective.id }).state;
    s = settleDecoys(s);
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
    // Spec 11: force resolves from LOCKED votes only — the single voter must
    // confirm for their vote to count; the rest abstain.
    s = applyCommand(s, { type: "castVote", playerId: living(s)[0]!.id, target: living(s)[1]!.id }).state;
    s = applyCommand(s, { type: "confirmVote", playerId: living(s)[0]!.id }).state;
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
    s = applyCommand(s, { type: "confirmVote", playerId: living(s)[1]!.id }).state;
    s = applyCommand(s, { type: "castVote", playerId: living(s)[2]!.id, target }).state;
    s = applyCommand(s, { type: "confirmVote", playerId: living(s)[2]!.id }).state;
    s = force(s);
    expect(s.deaths).toHaveLength(0);
  });

  test("runoff pins exclude no_murder and tied runoff resolves to peace", () => {
    let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 7));
    const ids = living(s).map((p) => p.id);
    s = castConfirm(s, ids[0]!, ids[1]!);
    s = castConfirm(s, ids[2]!, ids[3]!);
    s = force(s);
    expect(s.phase).toBe("runoff");
    s = castConfirm(s, ids[0]!, ids[1]!);
    s = castConfirm(s, ids[2]!, ids[3]!);
    s = force(s);
    expect(s.deaths).toHaveLength(0);
    let t = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 7));
    const tid = living(t).map((p) => p.id);
    t = castConfirm(t, tid[0]!, tid[1]!);
    t = castConfirm(t, tid[2]!, "no_murder");
    t = force(t);
    expect(t.phase).toBe("dusk");
    expect(t.deaths).toHaveLength(0);
  });

  test("other tie policies are deterministic and policy-specific", () => {
    const base = () => toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false, tiePolicy: "random" }), 7));
    const tied = (state: GameState) => {
      const ids = living(state).map((p) => p.id);
      let s = castConfirm(state, ids[0]!, ids[1]!);
      s = castConfirm(s, ids[2]!, ids[3]!);
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
    // Spec 08: force-advance/timer resolves from LOCKED votes only. A
    // single submitted-but-NOT-locked vote no longer lands on force —
    // zero locked votes means no kill.
    let s = start(5, rules({ mafia: 2, villager: 3 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = force(s);
    expect(s.players.find((p) => p.id === target.id)?.alive).toBe(true);
    expect(s.log.some((e) => e.type === "attackAttempted")).toBe(false);
    // Same scenario, but the sole living/non-absent voter locks first —
    // force-advance now resolves it (plurality among locked, denom 1).
    let sLocked = start(5, rules({ mafia: 2, villager: 3 }, { mafiaConsensus: "unanimous" }), 1);
    const mafiaLocked = sLocked.players.filter((p) => p.roleId === "mafia");
    const targetLocked = sLocked.players.find((p) => p.roleId !== "mafia")!;
    sLocked = applyCommand(sLocked, { type: "submitAction", playerId: mafiaLocked[0]!.id, targetId: targetLocked.id }).state;
    sLocked = applyCommand(sLocked, { type: "lockAction", playerId: mafiaLocked[0]!.id }).state;
    sLocked = force(sLocked);
    expect(sLocked.players.find((p) => p.id === targetLocked.id)?.alive).toBe(false);

    // markAbsent removes the absent killer from the lock denominator — the
    // sole remaining (non-absent) killer locking in is enough for natural
    // (non-forced) resolution.
    let t = start(5, rules({ mafia: 2, villager: 3 }, { mafiaConsensus: "unanimous" }), 1);
    const tm = t.players.filter((p) => p.roleId === "mafia");
    t = applyCommand(t, { type: "markAbsent", byHost: true, playerId: tm[1]!.id }).state;
    t = applyCommand(t, { type: "submitAction", playerId: tm[0]!.id, targetId: t.players.find((p) => p.roleId !== "mafia")!.id }).state;
    t = applyCommand(t, { type: "lockAction", playerId: tm[0]!.id }).state;
    // Spec 11: the villagers still owe their decoy locks for the night to
    // resolve naturally.
    t = settleDecoys(t);
    expect(t.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", outcome: "landed" }));

    // Majority mode: both killers submit and lock -> natural resolution.
    let majority = start(5, rules({ mafia: 2, villager: 3 }, { mafiaConsensus: "majority" }), 3);
    const mm = majority.players.filter((p) => p.roleId === "mafia");
    const mt = majority.players.find((p) => p.roleId !== "mafia")!;
    majority = applyCommand(majority, { type: "submitAction", playerId: mm[0]!.id, targetId: mt.id }).state;
    majority = applyCommand(majority, { type: "lockAction", playerId: mm[0]!.id }).state;
    majority = applyCommand(majority, { type: "submitAction", playerId: mm[1]!.id, targetId: mt.id }).state;
    majority = applyCommand(majority, { type: "lockAction", playerId: mm[1]!.id }).state;
    majority = settleDecoys(majority);
    expect(majority.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: mt.id }));

    // Designated mode: only the designated (lowest-seat) killer's lock
    // gates readiness — non-designated killers' lock state is irrelevant.
    let designated = start(4, rules({ mafia: 2, villager: 2 }, { mafiaConsensus: "designated" }), 4);
    const dm = designated.players.filter((p) => p.roleId === "mafia").sort((a, b) => a.seat - b.seat);
    const dt = designated.players.find((p) => p.roleId !== "mafia")!;
    designated = applyCommand(designated, { type: "submitAction", playerId: dm[0]!.id, targetId: dt.id }).state;
    designated = applyCommand(designated, { type: "lockAction", playerId: dm[0]!.id }).state;
    designated = settleDecoys(designated);
    expect(designated.phase).not.toBe("night");
  });

  test("unanimous consensus timeout resolves as plurality among LOCKED mafia votes", () => {
    // Spec 08 amends Spec 02 v2.3: force/timer resolves from LOCKED votes
    // only. All three lock in (so the phase is naturally ready, but
    // unanimous mode's convergence check fails on a genuine 2-1 split,
    // leaving the night open — "keep deciding" — until the host forces).
    let s = start(8, rules({ mafia: 3, villager: 5 }, { mafiaConsensus: "unanimous" }), 2);
    const mafia = s.players.filter((p) => p.roleId === "mafia").sort((a, b) => a.seat - b.seat);
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    const other = s.players.find((p) => p.roleId !== "mafia" && p.id !== target.id)!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[1]!.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[2]!.id, targetId: other.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[2]!.id }).state;
    expect(s.phase).toBe("night"); // all locked but disagreeing -> stays open
    s = force(s);
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: target.id, outcome: "landed" }));
    expect(s.log.filter((e) => e.type === "attackAttempted")).toHaveLength(1);
  });

  test("unanimous disagreement with unlocked votes: force-advance resolves zero kill (nothing locked)", () => {
    // Companion case: submitted-but-not-locked votes are discarded entirely
    // by the force/timer fallback — zero locked votes means no kill, even
    // though under the OLD "plurality among submitted" rule this would have
    // landed on `target`.
    let s = start(8, rules({ mafia: 3, villager: 5 }, { mafiaConsensus: "unanimous" }), 2);
    const mafia = s.players.filter((p) => p.roleId === "mafia").sort((a, b) => a.seat - b.seat);
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    const other = s.players.find((p) => p.roleId !== "mafia" && p.id !== target.id)!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[2]!.id, targetId: other.id }).state;
    s = force(s);
    expect(s.log.some((e) => e.type === "attackAttempted")).toBe(false);
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
    // Spec 08: the sole killer must lock in for the vote to count on
    // force-advance (locked-only plurality).
    e = applyCommand(e, { type: "lockAction", playerId: mafia.id }).state;
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
    // Spec 11: the mafia-kill is unavailable on a firstNightKill=false night 1
    // — so the mafia's night input falls through to the inert decoy `"watch"`
    // (they are no longer a mafia-consensus killer this night, so
    // `canSubmitMafiaVote` is false). A submitted target therefore files a
    // harmless watch (no rejection) and NO kill is attempted.
    const mafiaAttempt = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: target.id });
    expect(mafiaAttempt.rejection).toBeUndefined();
    s = mafiaAttempt.state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: angel.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: angel.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: detective.id }).state;
    s = settleDecoys(s); // the two villagers also owe decoys
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

  test("forceAdvance mid-night applies the same defaults, including mafia plurality-of-LOCKED", () => {
    // Spec 08 amends Spec 02 v2.3: force-advance resolves from LOCKED votes
    // only. One killer submits AND locks (the other never acts) -> the
    // locked vote still lands by plurality (denom of 1 locked vote).
    let s = start(8, rules({ mafia: 2, villager: 6 }, { mafiaConsensus: "unanimous" }), 2);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    s = force(s);
    expect(s.phase).toBe("dawn");
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: target.id, outcome: "landed" }));

    // Companion: submitted but NOT locked -> discarded entirely, no kill
    // (this is the case that changed from the old "plurality among
    // submitted" rule).
    let u = start(8, rules({ mafia: 2, villager: 6 }, { mafiaConsensus: "unanimous" }), 2);
    const uMafia = u.players.filter((p) => p.roleId === "mafia");
    const uTarget = u.players.find((p) => p.roleId !== "mafia")!;
    u = applyCommand(u, { type: "submitAction", playerId: uMafia[0]!.id, targetId: uTarget.id }).state;
    u = force(u);
    expect(u.phase).toBe("dawn");
    expect(u.log.some((e) => e.type === "attackAttempted")).toBe(false);
    expect(u.deaths).toHaveLength(0);

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
    // Spec 11: every living player owes a night input, so settle everyone
    // EXCEPT the detective first — leaving the detective as the sole pending
    // actor. Marking them absent removes the last pending input -> dawn.
    s = settleDecoys(s, [detective.id]);
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

  test("player-triggered phase completions (no forceAdvance) still arm the next beat's deadline", () => {
    // Regression: submitAction/castVote completing a phase used to call
    // advanceIfComplete with no `now`, so a player's own last action into
    // dawn/dusk silently stranded the game with deadlineAt: null and no
    // alarm ever armed. Only host-issued forceAdvance carried `now`.
    const r = rules({ mafia: 1, detective: 1, villager: 2 }, { dawnDuskBeatMs: 4242 });
    let s = start(4, r, 5);
    const mafia = byRole(s, "mafia");
    const detective = byRole(s, "detective");
    const villagers = s.players.filter((p) => p.roleId === "villager");
    expect(s.phase).toBe("night");

    // Spec 11: every living player owes a night input, so drive them all —
    // mafia (submit+lock), detective (submit+lock), villagers[0] (decoy via
    // settleDecoys). villagers[1]'s decoy lock is the LAST player-triggered
    // completion into dawn, and it must arm the beat deadline (the regression
    // guard: a player's own final action, not just the host's forceAdvance,
    // carries `now`).
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: villagers[0]!.id, now: NOW + 10 }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id, now: NOW + 10 }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id, now: NOW + 10 }).state;
    s = applyCommand(s, { type: "lockAction", playerId: detective.id, now: NOW + 10 }).state;
    s = settleDecoys(s, [villagers[1]!.id]);
    expect(s.phase).toBe("night"); // villagers[1] still owes their decoy
    s = applyCommand(s, { type: "submitAction", playerId: villagers[1]!.id, targetId: mafia.id, now: NOW + 10 }).state;
    const lockResult = applyCommand(s, { type: "lockAction", playerId: villagers[1]!.id, now: NOW + 10 });
    s = lockResult.state;
    expect(s.phase).toBe("dawn");
    expect(s.deadlineAt).toBe(NOW + 10 + 4242);
    expect(lockResult.effects).toContainEqual({ type: "setDeadline", at: NOW + 10 + 4242 });

    // dawn is acknowledge-gated (Spec 11) — the last living ack transitions
    // into day and must likewise arm nothing new (day is untimed here). Drive
    // the acks then force any remainder is unnecessary; ack them all.
    const livingDawn = living(s);
    for (const p of livingDawn) {
      s = applyCommand(s, { type: "acknowledge", playerId: p.id, gen: s.phaseGen, now: NOW + 15 }).state;
    }
    expect(s.phase).toBe("day");

    // Last day vote CONFIRMED by a player completes the vote and transitions
    // into dusk (Spec 11: confirm, not just cast, is the completion).
    const alive = living(s);
    let voteResult = applyCommand(s, { type: "castVote", playerId: alive[0]!.id, target: "no_murder", now: NOW + 20 });
    voteResult = applyCommand(voteResult.state, { type: "confirmVote", playerId: alive[0]!.id, now: NOW + 20 });
    for (const p of alive.slice(1)) {
      voteResult = applyCommand(voteResult.state, { type: "castVote", playerId: p.id, target: "no_murder", now: NOW + 20 });
      voteResult = applyCommand(voteResult.state, { type: "confirmVote", playerId: p.id, now: NOW + 20 });
    }
    s = voteResult.state;
    expect(s.phase).toBe("dusk");
    expect(s.deadlineAt).toBe(NOW + 20 + 4242);
    expect(voteResult.effects).toContainEqual({ type: "setDeadline", at: NOW + 20 + 4242 });
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
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: angel.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: angel.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: detective.id }).state;
    s = settleDecoys(s); // the two villagers owe decoys
    expect(s.phase).toBe("dawn");
    expectJoinOrder(s, { kind: "player", id: villager.id });
    s = force(s);
    expect(s.phase).toBe("day");
    expectJoinOrder(s, { kind: "player", id: villager.id });
    s = voteOut(s, mafia.id);
    expectJoinOrder(s, { kind: "player", id: villager.id });
    expectJoinOrder(s, { kind: "public" });
  });

  test("projection: you.mafiaRoster is present for living minion and mafia, absent for villager/detective, and unaffected by dead god view", () => {
    let s = start(5, rules({ mafia: 2, minion: 1, villager: 2 }, { firstNightKill: false }), 2);
    const mafiaPlayers = s.players.filter((p) => p.roleId === "mafia");
    const minion = byRole(s, "minion");
    const villager = byRole(s, "villager");
    const detective = s.players.find((p) => p.roleId === "detective");
    expect(detective).toBeUndefined();

    const minionView = projectFor(s, { kind: "player", id: minion.id });
    expect(minionView.you?.mafiaRoster?.sort()).toEqual(mafiaPlayers.map((p) => p.id).sort());

    for (const mafiaPlayer of mafiaPlayers) {
      const view = projectFor(s, { kind: "player", id: mafiaPlayer.id });
      const expectedPartners = mafiaPlayers.filter((p) => p.id !== mafiaPlayer.id).map((p) => p.id);
      expect(view.you?.mafiaRoster?.sort()).toEqual(expectedPartners.sort());
    }

    const villagerView = projectFor(s, { kind: "player", id: villager.id });
    expect(villagerView.you).not.toHaveProperty("mafiaRoster");

    // Dead god view (host/dead/ended) already gets full roles via `players[]`
    // — mafiaRoster is a living-viewer knowledge grant, not a god-view field.
    const deadState = { ...s, players: s.players.map((p) => (p.id === villager.id ? { ...p, alive: false } : p)) };
    const deadVillagerView = projectFor(deadState, { kind: "player", id: villager.id });
    expect(deadVillagerView.you).not.toHaveProperty("mafiaRoster");
  });

  test("projection: you.currentVote reflects the viewer's own standing vote regardless of votingVisibility, hidden or realtime", () => {
    for (const votingVisibility of ["hidden", "realtime"] as const) {
      let s = toDay(start(5, rules({ mafia: 1, detective: 1, angel: 1, villager: 2 }, { votingVisibility }), 9));
      const villager = byRole(s, "villager");
      const other = living(s).find((p) => p.id !== villager.id)!;

      expect(projectFor(s, { kind: "player", id: villager.id }).you?.currentVote).toBeUndefined();

      s = applyCommand(s, { type: "castVote", playerId: villager.id, target: other.id }).state;
      expect(projectFor(s, { kind: "player", id: villager.id }).you?.currentVote).toBe(other.id);

      s = applyCommand(s, { type: "castVote", playerId: villager.id, target: "no_murder" }).state;
      expect(projectFor(s, { kind: "player", id: villager.id }).you?.currentVote).toBe("no_murder");

      // Not the voter's own view: hidden mode must still say nothing about
      // this or other players' votes beyond what `voted`/`votes` already gave.
      const otherView = projectFor(s, { kind: "player", id: other.id });
      expect(otherView.you?.currentVote).toBeUndefined();

      s = applyCommand(s, { type: "retractVote", playerId: villager.id }).state;
      expect(projectFor(s, { kind: "player", id: villager.id }).you?.currentVote).toBeUndefined();
    }
  });

  test("projection: host-only players[].acted tracks night-action submission (mafia: LOCKED-only per Spec 08), undefined for non-actors, leak-free elsewhere", () => {
    let s = start(5, rules({ mafia: 1, detective: 1, angel: 1, villager: 2 }), 9);
    const mafia = byRole(s, "mafia");
    const detective = byRole(s, "detective");
    const villager = byRole(s, "villager");

    const seatIn = (view: ReturnType<typeof projectFor>, id: string) => view.players.find((p) => p.id === id);

    // Actor (detective) hasn't confirmed yet: host sees acted === false.
    // Spec 11: an individual actor now counts as `acted` only once LOCKED
    // (uniform with mafia), so a bare submit stays `false`.
    let hostView = projectFor(s, { kind: "host" });
    expect(seatIn(hostView, detective.id)?.acted).toBe(false);

    // Spec 11: the villager now owes a decoy `"watch"` input too — so the host
    // sees `acted: false` (pending), not undefined. Every living seat owes a
    // night input now; no seat is "asleep".
    expect(seatIn(hostView, villager.id)?.acted).toBe(false);

    // Mafia consensus participant also starts false (owes the kill-vote).
    expect(seatIn(hostView, mafia.id)?.acted).toBe(false);

    // Detective submits but does NOT lock -> still false (Spec 11 uniform).
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: villager.id }).state;
    hostView = projectFor(s, { kind: "host" });
    expect(seatIn(hostView, detective.id)?.acted).toBe(false);
    // Detective locks -> acted flips true.
    s = applyCommand(s, { type: "lockAction", playerId: detective.id }).state;
    hostView = projectFor(s, { kind: "host" });
    expect(seatIn(hostView, detective.id)?.acted).toBe(true);
    // Mafia hasn't voted yet: still false.
    expect(seatIn(hostView, mafia.id)?.acted).toBe(false);

    // Spec 08: mafia submits its kill-vote but does NOT lock -> still
    // pending (`acted` stays false) — a tentative pick is not "acted".
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: villager.id }).state;
    hostView = projectFor(s, { kind: "host" });
    expect(seatIn(hostView, mafia.id)?.acted).toBe(false);

    // Only once the mafia LOCKS its pick does the host see acted flip true.
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;
    hostView = projectFor(s, { kind: "host" });
    expect(seatIn(hostView, mafia.id)?.acted).toBe(true);

    // Leak check: player and public projections never carry acted for any
    // seat, including the actor's own seat in their own projection.
    const detectiveOwnView = projectFor(s, { kind: "player", id: detective.id });
    for (const p of detectiveOwnView.players) expect(p.acted).not.toBe(true), expect(p.acted).not.toBe(false);
    const publicView = projectFor(s, { kind: "public" });
    for (const p of publicView.players) expect(p.acted).not.toBe(true), expect(p.acted).not.toBe(false);

    // Leak check: a dead player's god view is resolved-only — no acted leak
    // for the current unresolved night phase either.
    const deadState = { ...s, players: s.players.map((p) => (p.id === villager.id ? { ...p, alive: false } : p)) };
    const deadVillagerView = projectFor(deadState, { kind: "player", id: villager.id });
    for (const p of deadVillagerView.players) expect(p.acted).not.toBe(true), expect(p.acted).not.toBe(false);
  });

  // ---------------------------------------------------------------------
  // Spec 08 — lock-in team voting (D1)
  // ---------------------------------------------------------------------

  test("lock-in: tentative picks don't resolve the night, even when they'd match", () => {
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: target.id }).state;
    // Both picked the SAME target but neither has locked — the phase must
    // stay open (a stray matching tap never ends the night early).
    expect(s.phase).toBe("night");
    expect(s.log.some((e) => e.type === "attackAttempted")).toBe(false);
  });

  test("lock-in: all-locked-agree (unanimous) resolves the kill", () => {
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    expect(s.phase).toBe("night");
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[1]!.id }).state;
    // Spec 11: mafia consensus is met, but the 5 villagers still owe decoys.
    expect(s.phase).toBe("night");
    s = settleDecoys(s);
    expect(s.phase).toBe("dawn");
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: target.id, outcome: "landed" }));
  });

  test("lock-in: all-locked-disagree (unanimous) stays open — no resolution, keep deciding", () => {
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const villagers = s.players.filter((p) => p.roleId !== "mafia");
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: villagers[0]!.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: villagers[1]!.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[1]!.id }).state;
    // Both locked, but on DIFFERENT targets — must stay open.
    expect(s.phase).toBe("night");
    expect(projectFor(s, { kind: "player", id: mafia[0]!.id }).you?.consensusReached).toBe(false);
    expect(s.log.some((e) => e.type === "attackAttempted")).toBe(false);
  });

  test("lock-in: majority mode resolves by plurality of LOCKED targets once all locked", () => {
    let s = start(9, rules({ mafia: 3, villager: 6 }, { mafiaConsensus: "majority" }), 3);
    const mafia = s.players.filter((p) => p.roleId === "mafia").sort((a, b) => a.seat - b.seat);
    const villagers = s.players.filter((p) => p.roleId !== "mafia");
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: villagers[0]!.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: villagers[0]!.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[1]!.id }).state;
    expect(s.phase).toBe("night"); // mafia[2] hasn't locked yet
    s = applyCommand(s, { type: "submitAction", playerId: mafia[2]!.id, targetId: villagers[1]!.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[2]!.id }).state;
    s = settleDecoys(s); // 6 villagers owe decoys
    expect(s.phase).toBe("dawn");
    // 2 of 3 locked on villagers[0] -> plurality wins, not villagers[1].
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: villagers[0]!.id, outcome: "landed" }));
    expect(s.log.filter((e) => e.type === "attackAttempted")).toHaveLength(1);
  });

  test("lock-in: force-advance/timer resolve from LOCKED votes only (unlocked tentative picks discarded)", () => {
    // Two mafia both TENTATIVELY pick the same target (never lock) -> force
    // yields zero kill, not the naive "they agreed" outcome.
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: target.id }).state;
    s = force(s);
    expect(s.log.some((e) => e.type === "attackAttempted")).toBe(false);

    // One locks, one stays tentative -> force resolves from the ONE locked
    // vote (plurality among locked, denom 1), discarding the tentative one.
    let t = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const tMafia = t.players.filter((p) => p.roleId === "mafia");
    const tTarget = t.players.find((p) => p.roleId !== "mafia")!;
    const tOther = t.players.find((p) => p.roleId !== "mafia" && p.id !== tTarget.id)!;
    t = applyCommand(t, { type: "submitAction", playerId: tMafia[0]!.id, targetId: tTarget.id }).state;
    t = applyCommand(t, { type: "lockAction", playerId: tMafia[0]!.id }).state;
    t = applyCommand(t, { type: "submitAction", playerId: tMafia[1]!.id, targetId: tOther.id }).state;
    t = force(t);
    expect(t.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: tTarget.id, outcome: "landed" }));
    expect(t.log.filter((e) => e.type === "attackAttempted")).toHaveLength(1);
  });

  test("lock-in: markAbsent on an unlocked killer unblocks natural resolution (removed from the lock denominator)", () => {
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    expect(s.phase).toBe("night"); // mafia[1] hasn't acted at all
    s = settleDecoys(s); // 5 villagers owe decoys
    expect(s.phase).toBe("night"); // still blocked on the unlocked mafia[1]
    s = applyCommand(s, { type: "markAbsent", byHost: true, playerId: mafia[1]!.id }).state;
    expect(s.phase).toBe("dawn");
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: target.id, outcome: "landed" }));
  });

  test("lock-in: unlock returns a locked pick to tentative and re-opens the night", () => {
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[1]!.id }).state;
    s = settleDecoys(s); // Spec 11: villagers owe decoys
    expect(s.phase).toBe("dawn"); // resolved

    // Re-run the same script but unlock mafia[1] right before what would
    // have been the resolving lock — night must NOT resolve.
    let t = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const tMafia = t.players.filter((p) => p.roleId === "mafia");
    const tTarget = t.players.find((p) => p.roleId !== "mafia")!;
    t = applyCommand(t, { type: "submitAction", playerId: tMafia[0]!.id, targetId: tTarget.id }).state;
    t = applyCommand(t, { type: "lockAction", playerId: tMafia[0]!.id }).state;
    t = applyCommand(t, { type: "submitAction", playerId: tMafia[1]!.id, targetId: tTarget.id }).state;
    t = applyCommand(t, { type: "lockAction", playerId: tMafia[1]!.id }).state;
    t = settleDecoys(t);
    expect(t.phase).toBe("dawn");
    // Can't unlock post-resolution (phase gate) — prove unlock genuinely
    // re-opens readiness by unlocking BEFORE the second lock instead.
    let u = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const uMafia = u.players.filter((p) => p.roleId === "mafia");
    const uTarget = u.players.find((p) => p.roleId !== "mafia")!;
    u = applyCommand(u, { type: "submitAction", playerId: uMafia[0]!.id, targetId: uTarget.id }).state;
    u = applyCommand(u, { type: "lockAction", playerId: uMafia[0]!.id }).state;
    u = applyCommand(u, { type: "unlockAction", playerId: uMafia[0]!.id }).state;
    u = applyCommand(u, { type: "submitAction", playerId: uMafia[1]!.id, targetId: uTarget.id }).state;
    u = applyCommand(u, { type: "lockAction", playerId: uMafia[1]!.id }).state;
    u = settleDecoys(u); // villagers locked, so mafia is the only blocker
    // mafia[0] unlocked itself -> only 1 of 2 locked -> still pending.
    expect(u.phase).toBe("night");
    u = applyCommand(u, { type: "lockAction", playerId: uMafia[0]!.id }).state;
    expect(u.phase).toBe("dawn");
  });

  test("lock-in: changing target (a new submitAction) clears an existing lock", () => {
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const villagers = s.players.filter((p) => p.roleId !== "mafia");
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: villagers[0]!.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: villagers[0]!.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[1]!.id }).state;
    s = settleDecoys(s); // villagers owe decoys
    expect(s.phase).toBe("dawn"); // sanity: this script does resolve if uninterrupted

    // Same script, but mafia[0] changes their target AFTER locking, right
    // before mafia[1] locks — the changed pick must revert to tentative.
    let t = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const tMafia = t.players.filter((p) => p.roleId === "mafia");
    const tVillagers = t.players.filter((p) => p.roleId !== "mafia");
    t = applyCommand(t, { type: "submitAction", playerId: tMafia[0]!.id, targetId: tVillagers[0]!.id }).state;
    t = applyCommand(t, { type: "lockAction", playerId: tMafia[0]!.id }).state;
    t = applyCommand(t, { type: "submitAction", playerId: tMafia[0]!.id, targetId: tVillagers[1]!.id }).state;
    const tVote = t.mafiaVotes.find((v) => v.playerId === tMafia[0]!.id);
    expect(tVote?.locked).toBe(false);
    expect(tVote?.targetId).toBe(tVillagers[1]!.id);
    t = applyCommand(t, { type: "submitAction", playerId: tMafia[1]!.id, targetId: tVillagers[0]!.id }).state;
    t = applyCommand(t, { type: "lockAction", playerId: tMafia[1]!.id }).state;
    // mafia[0]'s re-picked vote is unlocked -> still pending.
    expect(t.phase).toBe("night");
  });

  test("lock-in: designated mode gates readiness on only the designated killer's lock; non-designated lock state is irrelevant", () => {
    let s = start(6, rules({ mafia: 2, villager: 4 }, { mafiaConsensus: "designated" }), 4);
    const dm = s.players.filter((p) => p.roleId === "mafia").sort((a, b) => a.seat - b.seat);
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    // Non-designated killer submits+locks a DIFFERENT target -> irrelevant.
    s = applyCommand(s, { type: "submitAction", playerId: dm[1]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: dm[1]!.id }).state;
    expect(s.phase).toBe("night"); // designated killer hasn't locked yet
    s = applyCommand(s, { type: "submitAction", playerId: dm[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: dm[0]!.id }).state;
    s = settleDecoys(s); // 4 villagers owe decoys
    expect(s.phase).toBe("dawn");
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: target.id, outcome: "landed" }));
  });

  test("lock-in protocol semantics: no_pick_to_lock, not_lockable (wrong role/phase/absent), and phase-gate after resolution", () => {
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const villager = byRole(s, "villager");

    // No pick set yet -> no_pick_to_lock.
    const noPick = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id });
    expect(noPick.rejection?.code).toBe("no_pick_to_lock");

    // Spec 11: a villager now owes a decoy `"watch"`, so with no pick set yet
    // they also get `no_pick_to_lock` (not `not_lockable` — they DO have a
    // lockable night input now, just no pick). A genuinely un-lockable seat
    // (dead/absent) is gated upstream in applyCommand before reaching here.
    const villagerNoPick = applyCommand(s, { type: "lockAction", playerId: villager.id });
    expect(villagerNoPick.rejection?.code).toBe("no_pick_to_lock");

    // Resolve the night fully, then attempt to lock/unlock post-resolution
    // -> not_lockable (phase-gated before role-gated), never silently
    // ignored.
    const target = s.players.find((p) => p.roleId !== "mafia")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia[1]!.id }).state;
    s = settleDecoys(s); // villagers owe decoys
    expect(s.phase).toBe("dawn");
    const postResolutionLock = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id });
    expect(postResolutionLock.rejection?.code).toBe("not_lockable");
    const postResolutionUnlock = applyCommand(s, { type: "unlockAction", playerId: mafia[0]!.id });
    expect(postResolutionUnlock.rejection?.code).toBe("not_lockable");
  });

  test("projection: factionVotes covers ALL living killers (undecided -> null), lockedCount, and consensusReached is locked+converged", () => {
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia").sort((a, b) => a.seat - b.seat);
    const target = s.players.find((p) => p.roleId !== "mafia")!;

    // Nobody has picked yet: factionVotes still lists both killers, both
    // undecided (targetId null) — length is the killer COUNT, not a
    // picked-count proxy.
    let view = projectFor(s, { kind: "player", id: mafia[0]!.id });
    expect(view.you?.factionVotes).toHaveLength(2);
    expect(view.you?.factionVotes?.every((v) => v.targetId === null && !v.locked)).toBe(true);
    expect(view.you?.lockedCount).toBe(0);
    expect(view.you?.consensusReached).toBe(false);

    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: target.id }).state;
    view = projectFor(s, { kind: "player", id: mafia[1]!.id });
    const mine = view.you?.factionVotes?.find((v) => v.voterId === mafia[0]!.id);
    expect(mine).toEqual({ voterId: mafia[0]!.id, targetId: target.id, locked: false });
    expect(view.you?.lockedCount).toBe(0);

    s = applyCommand(s, { type: "lockAction", playerId: mafia[0]!.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: mafia[1]!.id, targetId: target.id }).state;
    view = projectFor(s, { kind: "player", id: mafia[1]!.id });
    expect(view.you?.lockedCount).toBe(1);
    expect(view.you?.consensusReached).toBe(false); // mafia[1] hasn't locked

    s = applyCommand(s, { type: "lockAction", playerId: mafia[1]!.id }).state;
    // Spec 11: mafia consensus is met but the 5 villagers still owe decoys.
    expect(s.phase).toBe("night");
    s = settleDecoys(s);
    expect(s.phase).toBe("dawn");
  });

  test("projection: factionVotes leak-free — not present for non-killers, and no live tentative picks leak to a dead ex-mafia's mid-night god view", () => {
    let s = start(7, rules({ mafia: 2, villager: 5 }, { mafiaConsensus: "unanimous" }), 1);
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    const villager = byRole(s, "villager");
    s = applyCommand(s, { type: "submitAction", playerId: mafia[0]!.id, targetId: villager.id }).state;

    // Non-mafia living viewer: no factionVotes at all.
    expect(projectFor(s, { kind: "player", id: villager.id }).you?.factionVotes).toBeUndefined();

    // A dead ex-mafia's god view is resolved-only (Spec 02 v2.2, unchanged
    // by Spec 08) — no live tentative picks leaked mid-night.
    const deadState = { ...s, players: s.players.map((p) => (p.id === mafia[0]!.id ? { ...p, alive: false } : p)) };
    const deadMafiaView = projectFor(deadState, { kind: "player", id: mafia[0]!.id });
    expect(deadMafiaView.you?.factionVotes).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Spec 11 — uniform interaction: day-vote confirm, decoy night actions,
  // morning-report acknowledge, no-count-leak.
  // ---------------------------------------------------------------------

  test("day vote: all-tentative (cast, not confirmed) does NOT resolve; all-confirmed does", () => {
    // 5 players so a single elimination doesn't end the game — we want to
    // observe the dawn/dusk transition, not a win.
    let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 5));
    const ids = living(s).map((p) => p.id);
    // Everyone casts the same target but NOBODY confirms -> phase stays open
    // (the redefined pendingVotes counts unlocked voters — a stray all-
    // tentative table must not resolve early).
    for (const id of ids) s = applyCommand(s, { type: "castVote", playerId: id, target: ids[1]! }).state;
    expect(s.phase).toBe("day");
    // Confirm each -> the last confirmation resolves the vote naturally.
    for (const id of ids) s = applyCommand(s, { type: "confirmVote", playerId: id }).state;
    expect(s.phase).toBe("dusk");
    expect(s.deaths.filter((d) => d.cause === "vote")).toHaveLength(1);
  });

  test("day vote: untimed day with unconfirmed voters does NOT hang and does NOT resolve early — host force resolves from locked only", () => {
    let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 5));
    // Target a villager so a single elimination doesn't end the game (we want
    // to observe the dusk transition + the locked-only resolution).
    const victim = living(s).find((p) => p.roleId === "villager")!.id;
    const others = living(s).filter((p) => p.id !== victim).map((p) => p.id);
    // Two players confirm on the villager; a third leaves a tentative pick.
    s = castConfirm(s, others[0]!, victim);
    s = castConfirm(s, others[1]!, victim);
    s = applyCommand(s, { type: "castVote", playerId: others[2]!, target: others[3]! }).state; // tentative
    // No timer, not everyone locked -> the phase must NOT auto-resolve.
    expect(s.phase).toBe("day");
    // Host force-advances: resolve from LOCKED votes only (the 2 confirmed on
    // the villager win; the tentative one abstains).
    s = force(s);
    expect(s.phase).toBe("dusk");
    expect(s.deaths.at(-1)?.playerId).toBe(victim);
  });

  test("night decoy: a villager's watch pick is inert (no visit, no death, no attack)", () => {
    let s = start(3, rules({ mafia: 1, villager: 2 }, { firstNightKill: false }), 5);
    const villagers = s.players.filter((p) => p.roleId === "villager");
    const mafia = byRole(s, "mafia");
    // A villager "watches" the mafia — this must create no observable effect.
    s = applyCommand(s, { type: "submitAction", playerId: villagers[0]!.id, targetId: mafia.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: villagers[0]!.id }).state;
    s = settleDecoys(s);
    expect(s.phase).toBe("dawn");
    expect(s.log.some((e) => e.type === "attackAttempted")).toBe(false);
    expect(s.deaths).toHaveLength(0);
    expect(s.players.every((p) => p.alive)).toBe(true);
  });

  test("night decoy: a watch target is ABSENT from every non-host projection, present for the host", () => {
    let s = start(3, rules({ mafia: 1, villager: 2 }, { firstNightKill: false }), 5);
    const villagers = s.players.filter((p) => p.roleId === "villager");
    const mafia = byRole(s, "mafia");
    const watcher = villagers[0]!;
    const watched = mafia.id;
    s = applyCommand(s, { type: "submitAction", playerId: watcher.id, targetId: watched }).state;

    // The watcher's OWN view may reflect their own pick (that's not a leak).
    expect(projectFor(s, { kind: "player", id: watcher.id }).you?.pendingAction?.targetId).toBe(watched);
    expect(projectFor(s, { kind: "player", id: watcher.id }).you?.nightIsDecoy).toBe(true);

    // Every OTHER non-host viewer must not learn who the watcher watched.
    for (const viewer of [villagers[1]!.id, mafia.id]) {
      const view = projectFor(s, { kind: "player", id: viewer });
      // No actionSubmitted event carrying the watch target reaches a player.
      expect(view.log.some((e) => e.type === "actionSubmitted")).toBe(false);
      expect(JSON.stringify(view.log)).not.toContain("watch");
    }
    const publicView = projectFor(s, { kind: "public" });
    expect(JSON.stringify(publicView.log)).not.toContain("watch");
    // A dead player's god view is resolved-only — no live watch pick.
    const deadState = { ...s, players: s.players.map((p) => (p.id === villagers[1]!.id ? { ...p, alive: false } : p)) };
    const deadView = projectFor(deadState, { kind: "player", id: villagers[1]!.id });
    expect(deadView.log.some((e) => e.type === "actionSubmitted")).toBe(false);

    // The host DOES see the per-seat action (god view keeps actionSubmitted).
    const hostView = projectFor(s, { kind: "host" });
    expect(hostView.log.some((e) => e.type === "actionSubmitted" && e.actionType === "watch")).toBe(true);
  });

  test("night waits for EVERY living actor incl. decoy roles", () => {
    let s = start(4, rules({ mafia: 1, detective: 1, villager: 2 }), 5);
    const mafia = byRole(s, "mafia");
    const detective = byRole(s, "detective");
    const villagers = s.players.filter((p) => p.roleId === "villager");
    // Mafia + detective fully act and lock; one villager also settles.
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: villagers[0]!.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: detective.id }).state;
    s = settleDecoys(s, [villagers[1]!.id]);
    // The remaining villager's decoy is still owed -> night stays open.
    expect(s.phase).toBe("night");
    s = applyCommand(s, { type: "submitAction", playerId: villagers[1]!.id, targetId: mafia.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: villagers[1]!.id }).state;
    expect(s.phase).toBe("dawn");
  });

  test("no living-player pending-count field anywhere in a player projection (night AND day)", () => {
    let s = start(4, rules({ mafia: 1, detective: 1, villager: 2 }), 5);
    const villager = s.players.find((p) => p.roleId === "villager")!;
    const nightView = projectFor(s, { kind: "player", id: villager.id });
    for (const grep of [/pending.*count/i, /"pendingVotes"/, /"pendingNight"/, /"pendingDawn"/, /of \d+ have/i]) {
      expect(JSON.stringify(nightView)).not.toMatch(grep);
    }
    // Day view (with some votes cast) likewise carries no denominator.
    let day = toDay(s);
    const dayIds = living(day).map((p) => p.id);
    day = applyCommand(day, { type: "castVote", playerId: dayIds[0]!, target: dayIds[1]! }).state;
    const dayView = projectFor(day, { kind: "player", id: villager.id });
    // `voted`/`votes` only appear under realtime visibility; hidden (default)
    // exposes neither to the player.
    expect(dayView.voted).toBeUndefined();
    expect(dayView.votes).toBeUndefined();
    for (const grep of [/pending.*count/i, /of \d+ have/i]) {
      expect(JSON.stringify(dayView)).not.toMatch(grep);
    }
  });

  test("dawn acknowledge: all-ack advances; a stale-gen ack is a no-op", () => {
    // firstNightKill=false so night 1 has no kill and the game reaches dawn
    // with everyone alive (no early win to short-circuit the ack test).
    let s = start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 5);
    // Resolve the night into dawn (no real kill this night).
    s = settleDecoys(s);
    expect(s.phase).toBe("dawn");
    const dawnGen = s.phaseGen;
    const survivors = living(s);

    // A stale-gen ack (wrong phaseGen) is a rejected no-op — same state ref.
    const stale = applyCommand(s, { type: "acknowledge", playerId: survivors[0]!.id, gen: dawnGen + 99 });
    expect(stale.state).toBe(s);

    // Acknowledge with the right gen from every survivor advances to day.
    for (const p of survivors) {
      s = applyCommand(s, { type: "acknowledge", playerId: p.id, gen: dawnGen }).state;
    }
    expect(s.phase).toBe("day");
  });

  test("dawn acknowledge: the beat backstop (timerExpired) advances even with un-acked players", () => {
    let s = start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false, dawnDuskBeatMs: 3000 }), 5);
    s = settleDecoys(s);
    expect(s.phase).toBe("dawn");
    // Arm the dawn beat deadline (the natural transition through settleDecoys
    // carried no `now`), then fire it — the backstop advances to day with
    // nobody having acknowledged.
    s.deadlineAt = NOW + 3000;
    s = applyCommand(s, { type: "timerExpired", at: NOW + 3000, now: NOW + 3000 }).state;
    expect(s.phase).toBe("day");
  });

  test("full game N=3 (1 mafia + 2 villagers) terminates correctly (village wins by day vote)", () => {
    // The smallest legal setup Spec 11 unlocks. Seed chosen so p3 = mafia.
    let s = start(3, rules({ mafia: 1, villager: 2 }, { firstNightKill: false }), 5);
    const mafia = byRole(s, "mafia");
    const villagers = s.players.filter((p) => p.roleId === "villager");
    expect(s.phase).toBe("night");

    // Night 1: no kill (firstNightKill=false) — everyone still owes a decoy.
    s = settleDecoys(s);
    expect(s.phase).toBe("dawn");
    // Every survivor acknowledges the morning report -> day.
    for (const p of living(s)) s = applyCommand(s, { type: "acknowledge", playerId: p.id, gen: s.phaseGen }).state;
    expect(s.phase).toBe("day");

    // Day 1: the village confirms a vote on the mafia -> mafia eliminated,
    // village wins immediately (parity: 0 mafia left).
    s = voteOut(s, mafia.id);
    expect(s.phase).toBe("ended");
    expect(s.winners).toEqual(["village"]);
    expect(living(s).map((p) => p.id).sort()).toEqual(villagers.map((p) => p.id).sort());
  });
});

// -----------------------------------------------------------------------------
// Spec 12 — narrator board, sunrise/sunset (deferred resolution), game status.
// -----------------------------------------------------------------------------

describe("Spec 12: sunrise/sunset deferred resolution", () => {
  // Drive a night to full readiness (mafia locked, everyone else settled) so
  // the NEXT engine step is the night→(sunrise|dawn) transition.
  const readyNight = (state: GameState, killTarget: string) => {
    let s = state;
    const mafia = s.players.filter((p) => p.roleId === "mafia");
    for (const m of mafia) {
      s = applyCommand(s, { type: "submitAction", playerId: m.id, targetId: killTarget }).state;
      s = applyCommand(s, { type: "lockAction", playerId: m.id }).state;
    }
    return settleDecoys(s, mafia.map((m) => m.id));
  };

  test("scenePhases OFF: phase sequence is byte-identical to Spec 11 (regression backstop C3)", () => {
    // Same seed/ruleset, run once with scenePhases explicitly false (the
    // default). Asserts the resolved sequence night→dawn→day→dusk→night — NO
    // sunrise/sunset ever appears — and that a full snapshot is structurally
    // what Spec 11 produced (spot: phase values + no scene phase in the log).
    const r = rules({ mafia: 1, villager: 4 }, { firstNightKill: false, scenePhases: false });
    let s = start(5, r, 5);
    const seq: string[] = [s.phase];
    s = settleDecoys(s);
    seq.push(s.phase); // dawn (night resolved directly)
    for (const p of living(s)) s = applyCommand(s, { type: "acknowledge", playerId: p.id, gen: s.phaseGen }).state;
    seq.push(s.phase); // day
    const victim = living(s).find((p) => p.roleId === "villager")!.id;
    s = voteOut(s, victim);
    seq.push(s.phase); // dusk
    s = force(s);
    seq.push(s.phase); // night (day 2)
    expect(seq).toEqual(["night", "dawn", "day", "dusk", "night"]);
    expect(s.log.some((e) => e.type === "phaseChanged" && (e.phase === "sunrise" || e.phase === "sunset"))).toBe(false);
  });

  test("scenePhases ON: night readiness defers to sunrise WITHOUT resolving; reveal resolves to dawn", () => {
    const r = rules({ mafia: 1, villager: 4 }, { scenePhases: true });
    let s = start(5, r, 5);
    const mafia = byRole(s, "mafia");
    const victim = living(s).find((p) => p.roleId === "villager")!;
    s = readyNight(s, victim.id);
    // The night is READY but scenePhases defers: we are in sunrise, UNRESOLVED.
    expect(s.phase).toBe("sunrise");
    // LEAK PROOF: nothing resolved. Victim still alive, NO playerDied/
    // attackAttempted in the log, no death recorded.
    expect(s.players.find((p) => p.id === victim.id)?.alive).toBe(true);
    expect(s.log.some((e) => e.type === "playerDied")).toBe(false);
    expect(s.log.some((e) => e.type === "attackAttempted")).toBe(false);
    expect(s.deaths).toHaveLength(0);
    void mafia;

    // Host reveals -> NOW resolveNight + win run -> dawn, and the kill lands.
    const revealed = applyCommand(s, { type: "reveal", byHost: true, gen: s.phaseGen });
    s = revealed.state;
    expect(s.phase).toBe("dawn");
    expect(s.players.find((p) => p.id === victim.id)?.alive).toBe(false);
    expect(s.log).toContainEqual(expect.objectContaining({ type: "attackAttempted", targetId: victim.id, outcome: "landed" }));
  });

  test("scenePhases ON: day-vote readiness defers to sunset; reveal resolves to dusk", () => {
    const r = rules({ mafia: 1, villager: 4 }, { firstNightKill: false, scenePhases: true });
    let s = start(5, r, 5);
    // Reach day: night defers to sunrise, reveal -> dawn, ack -> day.
    s = settleDecoys(s);
    expect(s.phase).toBe("sunrise");
    s = applyCommand(s, { type: "reveal", byHost: true, gen: s.phaseGen }).state;
    expect(s.phase).toBe("dawn");
    for (const p of living(s)) s = applyCommand(s, { type: "acknowledge", playerId: p.id, gen: s.phaseGen }).state;
    expect(s.phase).toBe("day");

    // Everyone confirms a vote on a villager -> readiness defers to SUNSET
    // (vote UNRESOLVED: nobody eliminated yet).
    const victim = living(s).find((p) => p.roleId === "villager")!;
    s = voteOut(s, victim.id);
    expect(s.phase).toBe("sunset");
    expect(s.players.find((p) => p.id === victim.id)?.alive).toBe(true);
    expect(s.log.some((e) => e.type === "voteResolved")).toBe(false);

    // Reveal -> resolveVote + win -> dusk, elimination lands.
    s = applyCommand(s, { type: "reveal", byHost: true, gen: s.phaseGen }).state;
    expect(s.phase).toBe("dusk");
    expect(s.players.find((p) => p.id === victim.id)?.alive).toBe(false);
    expect(s.deaths.at(-1)?.cause).toBe("vote");
  });

  test("scenePhases ON: the sunrise HOLDING projection leaks no outcome to a player", () => {
    const r = rules({ mafia: 1, villager: 4 }, { scenePhases: true });
    let s = start(5, r, 5);
    const victim = living(s).find((p) => p.roleId === "villager")!;
    const observer = living(s).find((p) => p.roleId === "villager" && p.id !== victim.id)!;
    s = readyNight(s, victim.id);
    expect(s.phase).toBe("sunrise");

    const view = projectFor(s, { kind: "player", id: observer.id });
    // Victim still shows alive; no death event; no attack event; no action
    // detail (actionSubmitted stripped for non-god); no watch targets.
    expect(view.players.find((p) => p.id === victim.id)?.alive).toBe(true);
    expect(view.log.some((e) => e.type === "playerDied")).toBe(false);
    expect(view.log.some((e) => e.type === "attackAttempted")).toBe(false);
    expect(view.log.some((e) => e.type === "actionSubmitted")).toBe(false);
    expect(JSON.stringify(view.log)).not.toContain("watch");
    // The observer's own view carries no other player's role either.
    expect(view.players.some((p) => p.id !== observer.id && p.roleId)).toBe(false);
  });

  test("reveal command contract: host-only, reveal_not_active outside sunrise/sunset, stale_advance on gen mismatch; force-advance also works", () => {
    const r = rules({ mafia: 1, villager: 4 }, { scenePhases: true });
    let s = start(5, r, 5);

    // Not in a scene phase (night) -> reveal_not_active, even for the host.
    expect(applyCommand(s, { type: "reveal", byHost: true, gen: s.phaseGen }).rejection?.code).toBe("reveal_not_active");
    // Non-host reveal -> not_host.
    expect(applyCommand(s, { type: "reveal", byHost: false, gen: s.phaseGen }).rejection?.code).toBe("not_host");

    const victim = living(s).find((p) => p.roleId === "villager")!;
    s = readyNight(s, victim.id);
    expect(s.phase).toBe("sunrise");

    // Stale gen in a scene phase -> stale_advance (loud, not a silent no-op).
    expect(applyCommand(s, { type: "reveal", byHost: true, gen: s.phaseGen + 1 }).rejection?.code).toBe("stale_advance");

    // Host force-advance out of sunrise also resolves (the escape hatch).
    const forced = applyCommand(s, { type: "forceAdvance", byHost: true, gen: s.phaseGen });
    expect(forced.state.phase).toBe("dawn");
    expect(forced.state.players.find((p) => p.id === victim.id)?.alive).toBe(false);
  });

  test("scenePhases ON: host force-advance from a ready night resolves directly to dawn (bypasses sunrise)", () => {
    const r = rules({ mafia: 1, villager: 4 }, { scenePhases: true });
    let s = start(5, r, 5);
    const victim = living(s).find((p) => p.roleId === "villager")!;
    // Force-advance BEFORE readiness — the host's escape hatch resolves the
    // night directly (locked-plurality), never parking in sunrise.
    const mafia = byRole(s, "mafia");
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: victim.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;
    s = force(s);
    expect(s.phase).toBe("dawn");
  });
});

describe("Spec 12: game-status aggregates + narrator board history", () => {
  test("projection: rolesRemaining is aggregate-only for every viewer; no per-living-player role list", () => {
    let s = start(5, rules({ mafia: 1, detective: 1, angel: 1, villager: 2 }), 9);
    for (const viewer of [{ kind: "player" as const, id: byRole(s, "villager").id }, { kind: "host" as const }, { kind: "public" as const }]) {
      const view = projectFor(s, viewer);
      // Present and a sum-to-living aggregate.
      expect(view.rolesRemaining).toEqual(expect.any(Array));
      expect(view.rolesRemaining.reduce((n, r) => n + r.count, 0)).toBe(living(s).length);
      // Each entry is {roleId, count} — never carries a playerId.
      for (const rc of view.rolesRemaining) {
        expect(rc).toHaveProperty("roleId");
        expect(rc).toHaveProperty("count");
        expect(rc).not.toHaveProperty("playerId");
      }
      expect(view.headcount).toEqual({ alive: living(s).length, total: s.players.length });
    }
    // Full transparency: even a hidden/no-reveal ruleset exposes full counts.
    const hidden = start(5, rules({ mafia: 1, detective: 1, angel: 1, villager: 2 }, { revealOnDeath: "none", votingVisibility: "hidden" }), 9);
    const hv = projectFor(hidden, { kind: "player", id: byRole(hidden, "villager").id });
    expect(hv.rolesRemaining.find((r) => r.roleId === "mafia")?.count).toBe(1);
  });

  test("projection: graveyard follows revealOnDeath and never lists a living player", () => {
    // Kill a villager at night under revealOnDeath: full.
    let s = start(5, rules({ mafia: 1, detective: 1, angel: 1, villager: 2 }, { revealOnDeath: "full" }), 9);
    const mafia = byRole(s, "mafia");
    const victim = living(s).find((p) => p.roleId === "villager")!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: victim.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;
    s = settleDecoys(s, [mafia.id]);
    s = force(s); // dawn -> (ack path skipped via force) ... just need the death recorded
    const view = projectFor(s, { kind: "player", id: mafia.id });
    const grave = view.graveyard.find((g) => g.playerId === victim.id);
    expect(grave).toBeDefined();
    expect(grave?.roleId).toBe("villager"); // full reveal
    // No living player appears in the graveyard.
    const livingIds = new Set(living(s).map((p) => p.id));
    expect(view.graveyard.some((g) => livingIds.has(g.playerId))).toBe(false);

    // alignment-only reveal hides the exact role.
    let a = start(5, rules({ mafia: 1, detective: 1, angel: 1, villager: 2 }, { revealOnDeath: "alignment" }), 9);
    const am = byRole(a, "mafia");
    const av = living(a).find((p) => p.roleId === "villager")!;
    a = applyCommand(a, { type: "submitAction", playerId: am.id, targetId: av.id }).state;
    a = applyCommand(a, { type: "lockAction", playerId: am.id }).state;
    a = settleDecoys(a, [am.id]);
    a = force(a);
    const ag = projectFor(a, { kind: "player", id: am.id }).graveyard.find((g) => g.playerId === av.id);
    expect(ag?.roleId).toBeUndefined();
    expect(ag?.alignment).toBe("town");
  });

  test("narratorBoardHistory: reconstructs locked picks per day from the host log (locked-only, last-wins)", () => {
    let s = start(5, rules({ mafia: 1, detective: 1, angel: 1, villager: 2 }), 9);
    const mafia = byRole(s, "mafia");
    const detective = byRole(s, "detective");
    const victim = living(s).find((p) => p.roleId === "villager")!;

    // Detective submits then RE-submits a different target (clears lock), then
    // locks the second — history must show only the locked (second) target.
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: victim.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: detective.id }).state;
    // Mafia submits + locks.
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: victim.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;

    const hostView = projectFor(s, { kind: "host" });
    const history = narratorBoardHistory(hostView.log);
    const day1 = history.find((h) => h.day === 1)!;
    // Detective's locked row shows the SECOND (locked) target, not the first.
    const detRow = day1.nightActions.find((a) => a.actorId === detective.id);
    expect(detRow?.targetId).toBe(mafia.id);
    expect(detRow?.actionType).toBe("investigate");
    // A non-locked actor has no row. (Both villagers/angel haven't locked.)
    expect(day1.nightActions.some((a) => a.targetId === null && a.actorId !== detective.id && a.actorId !== mafia.id)).toBe(false);

    // A non-host projection's log cannot reconstruct night TARGETS: the helper
    // reads `actionSubmitted` targets, which `resolvedLog` strips from non-god
    // logs. `actionLocked` events (who locked, NO target) do still reach
    // players, so rows may exist — but every reconstructed target is null, so
    // no target leaks through this path.
    const villagerLog = projectFor(s, { kind: "player", id: victim.id }).log;
    // Confirm the player log truly carries no target-bearing action event.
    expect(villagerLog.some((e) => e.type === "actionSubmitted")).toBe(false);
    const villagerHistory = narratorBoardHistory(villagerLog);
    for (const day of villagerHistory) {
      for (const row of day.nightActions) expect(row.targetId).toBeNull();
    }
  });

  test("narratorBoardHistory: day votes reconstruct locked-only, unlock removes the row", () => {
    let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false }), 5));
    const ids = living(s).map((p) => p.id);
    // Two players cast+confirm, a third casts+confirms then UNCONFIRMS.
    s = castConfirm(s, ids[0]!, ids[1]!);
    s = castConfirm(s, ids[2]!, ids[1]!);
    s = applyCommand(s, { type: "castVote", playerId: ids[3]!, target: ids[1]! }).state;
    s = applyCommand(s, { type: "confirmVote", playerId: ids[3]! }).state;
    s = applyCommand(s, { type: "unconfirmVote", playerId: ids[3]! }).state;

    const history = narratorBoardHistory(projectFor(s, { kind: "host" }).log);
    const today = history.find((h) => h.day === s.day)!;
    const lockedVoters = today.dayVotes.map((v) => v.voterId).sort();
    expect(lockedVoters).toEqual([ids[0]!, ids[2]!].sort()); // ids[3] unlocked -> no row
    expect(today.dayVotes.find((v) => v.voterId === ids[0]!)?.target).toBe(ids[1]!);
  });
});

// ---------------------------------------------------------------------------
// Spec 15 — dedicated `{kind:"public"}` coverage. This is the projection's
// first PRODUCT caller (Spec 15's `buildStoryFacts` reads exactly this
// output — src/server/storyteller.ts); `{kind:"public"}` itself already had
// same-file spot-check coverage above (join-order, no-pending-count,
// rolesRemaining aggregate, watch-target leak) — this block adds the fields
// the AI narrator specifically depends on: `god` false pre-`ended`, no `you`,
// graveyard per `revealOnDeath`, tallies per `votingVisibility`, and log
// filtering identical to what a living player sees.
// ---------------------------------------------------------------------------
describe("Spec 15: {kind:'public'} projection — the AI narrator's sole input", () => {
  test("god is false pre-ended regardless of any dead player existing, and flips true only at game end", () => {
    let s = start(5, rules({ mafia: 1, villager: 2, angel: 1, detective: 1 }), 9);
    const mafia = byRole(s, "mafia");
    const angel = byRole(s, "angel");
    const detective = byRole(s, "detective");
    const target = s.players.find((p) => p.id !== mafia.id && p.id !== angel.id && p.id !== detective.id)!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;
    s = settleDecoys(s, [angel.id, detective.id]);
    s = applyCommand(s, { type: "submitAction", playerId: angel.id, targetId: mafia.id }).state; // no protection -> kill lands
    s = applyCommand(s, { type: "lockAction", playerId: angel.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: detective.id }).state;
    expect(s.phase).toBe("dawn");

    const publicAtDawn = projectFor(s, { kind: "public" });
    // A player is now dead (target). god must still be FALSE at a non-ended
    // phase — the dead-player god carve-out must not leak through a viewer
    // that structurally has no `viewerPlayer` match (Spec 15 review finding).
    expect(publicAtDawn.players.find((p) => p.id === target.id)?.alive).toBe(false);
    for (const p of publicAtDawn.players) {
      if (p.id !== target.id) {
        expect(p.roleId).toBeUndefined();
        expect(p.alignment).toBeUndefined();
      }
    }

    s = force(s); // -> day
    s = voteOut(s, mafia.id); // eliminating the sole mafia ends the game
    expect(s.phase).toBe("ended");
    const publicAtEnd = projectFor(s, { kind: "public" });
    // At `ended` the public projection IS legitimately god (winners/roles
    // public at game over — Spec 15's epilogue beat, not a leak).
    expect(publicAtEnd.players.every((p) => p.roleId !== undefined)).toBe(true);
    expect(publicAtEnd.winners).not.toBeNull();
  });

  test("public projection carries no `you` block ever (no viewer identity to leak)", () => {
    const s = start(5, rules({ mafia: 1, villager: 4 }), 5);
    expect(projectFor(s, { kind: "public" }).you).toBeUndefined();
  });

  test("graveyard on the public view follows revealOnDeath exactly like a living player's", () => {
    for (const revealOnDeath of ["full", "alignment", "none"] as const) {
      let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false, revealOnDeath }), 5));
      const victim = living(s)[0]!.id;
      s = voteOut(s, victim);
      const publicView = projectFor(s, { kind: "public" });
      const livingView = projectFor(s, { kind: "player", id: living(s)[0]!.id });
      const pubEntry = publicView.graveyard.find((g) => g.playerId === victim);
      const liveEntry = livingView.graveyard.find((g) => g.playerId === victim);
      expect(pubEntry).toEqual(liveEntry);
      if (revealOnDeath === "full") expect(pubEntry?.roleId).toBeDefined();
      if (revealOnDeath === "alignment") {
        expect(pubEntry?.roleId).toBeUndefined();
        expect(pubEntry?.alignment).toBeDefined();
      }
      if (revealOnDeath === "none") {
        expect(pubEntry?.roleId).toBeUndefined();
        expect(pubEntry?.alignment).toBeUndefined();
      }
    }
  });

  test("vote tallies on the public view are gated by votingVisibility identically to a living player's", () => {
    for (const votingVisibility of ["hidden", "realtime"] as const) {
      let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false, votingVisibility }), 5));
      s = applyCommand(s, { type: "castVote", playerId: living(s)[0]!.id, target: living(s)[1]!.id }).state;
      const publicView = projectFor(s, { kind: "public" });
      const livingView = projectFor(s, { kind: "player", id: living(s)[2]!.id });
      expect(publicView.votes !== undefined).toBe(votingVisibility === "realtime");
      expect(publicView.votes !== undefined).toBe(livingView.votes !== undefined);
    }
    // voteResolved (eliminatedId/reason) is ALWAYS public regardless of
    // votingVisibility — only the per-candidate tallies are gated (Spec 15
    // leak contract correction, M4).
    let s = toDay(start(5, rules({ mafia: 1, villager: 4 }, { firstNightKill: false, votingVisibility: "hidden" }), 5));
    const target = living(s)[0]!.id;
    s = voteOut(s, target);
    const publicView = projectFor(s, { kind: "public" });
    expect(publicView.log).toContainEqual(expect.objectContaining({ type: "voteResolved", eliminatedId: target }));
  });

  test("public log filtering matches a living player's exactly — no actionSubmitted/acknowledged/hidden-vote leakage", () => {
    let s = start(5, rules({ mafia: 1, villager: 2, angel: 1, detective: 1 }, { votingVisibility: "hidden" }), 9);
    const mafia = byRole(s, "mafia");
    const angel = byRole(s, "angel");
    const detective = byRole(s, "detective");
    const target = s.players.find((p) => p.id !== mafia.id && p.id !== angel.id && p.id !== detective.id)!;
    s = applyCommand(s, { type: "submitAction", playerId: mafia.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: mafia.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: angel.id, targetId: target.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: angel.id }).state;
    s = applyCommand(s, { type: "submitAction", playerId: detective.id, targetId: mafia.id }).state;
    s = applyCommand(s, { type: "lockAction", playerId: detective.id }).state;
    s = settleDecoys(s);
    for (const p of living(s)) {
      s = applyCommand(s, { type: "acknowledge", playerId: p.id, gen: s.phaseGen }).state;
    }
    const publicLog = projectFor(s, { kind: "public" }).log;
    const livingLog = projectFor(s, { kind: "player", id: living(s)[0]!.id }).log;
    expect(publicLog).toEqual(livingLog);
    expect(publicLog.some((e) => e.type === "actionSubmitted")).toBe(false);
    expect(publicLog.some((e) => e.type === "acknowledged")).toBe(false);
  });
});
