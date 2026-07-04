import { ATTACK_RANK, DEFENSE_RANK, type DefenseTier, type GameEvent, type GameState, type SubmittedAction } from "./types";
import { getRole, mafiaKillers, roleOrder, type RoleRegistry } from "./roles";

function defenseMax(a: DefenseTier, b: DefenseTier): DefenseTier {
  return DEFENSE_RANK[a] >= DEFENSE_RANK[b] ? a : b;
}

function submitted(state: GameState, actorId: string, type?: string): SubmittedAction | undefined {
  return state.nightActions.find((a) => a.actorId === actorId && (!type || a.actionType === type));
}

export function resolveMafiaTarget(state: GameState, registry: RoleRegistry): { actorId: string; targetId: string } | null {
  const killers = mafiaKillers(state, registry);
  if (killers.length === 0) return null;
  const votes = state.mafiaVotes.filter((v) => killers.some((p) => p.id === v.playerId) && v.targetId);
  if (votes.length === 0) return null;
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote.targetId!, (counts.get(vote.targetId!) ?? 0) + 1);
  const denom = killers.length;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || seatOf(state, a[0]) - seatOf(state, b[0]));
  const top = sorted[0]!;
  const converged =
    state.ruleset.mafiaConsensus === "designated"
      ? votes.some((v) => v.playerId === killers.sort((a, b) => a.seat - b.seat)[0]!.id)
      : state.ruleset.mafiaConsensus === "unanimous"
        ? top[1] === denom
        : top[1] > denom / 2;
  if (converged) {
    if (state.ruleset.mafiaConsensus === "designated") {
      const designated = killers.sort((a, b) => a.seat - b.seat)[0]!;
      const vote = votes.find((v) => v.playerId === designated.id);
      return vote?.targetId ? { actorId: designated.id, targetId: vote.targetId } : null;
    }
    return { actorId: votes.find((v) => v.targetId === top[0])!.playerId, targetId: top[0] };
  }
  return { actorId: votes.find((v) => v.targetId === top[0])!.playerId, targetId: top[0] };
}

function seatOf(state: GameState, playerId: string): number {
  return state.players.find((p) => p.id === playerId)?.seat ?? 9999;
}

export function resolveNight(input: GameState, registry: RoleRegistry): GameState {
  const state: GameState = { ...input, log: [...input.log], deaths: [...input.deaths], investigationResults: [...input.investigationResults] };
  const events: GameEvent[] = [];
  const blocked = new Set<string>();
  const roleblocks = state.nightActions
    .filter((a) => a.actionType === "roleblock" && a.targetId)
    .sort((a, b) => {
      const ar = getRole(registry, state.players.find((p) => p.id === a.actorId)!.roleId);
      const br = getRole(registry, state.players.find((p) => p.id === b.actorId)!.roleId);
      return roleOrder(ar.alignment) - roleOrder(br.alignment) || seatOf(state, a.actorId) - seatOf(state, b.actorId);
    });
  for (const block of roleblocks) {
    const targetAction = submitted(state, block.targetId!);
    if (targetAction?.actionType === "roleblock" && targetAction.targetId === block.actorId) {
      blocked.add(block.actorId);
      blocked.add(block.targetId!);
    } else if (!blocked.has(block.actorId)) {
      blocked.add(block.targetId!);
    }
  }

  const defenses: Record<string, DefenseTier> = {};
  for (const player of state.players) defenses[player.id] = getRole(registry, player.roleId).defenseTier ?? "none";
  for (const protect of state.nightActions.filter((a) => a.actionType === "protect" && a.targetId)) {
    if (!blocked.has(protect.actorId)) defenses[protect.targetId!] = defenseMax(defenses[protect.targetId!] ?? "none", "powerful");
  }

  const killAttempts: { actorId: string; targetId: string; attack: "basic" | "powerful" | "unstoppable" }[] = [];
  const mafiaTarget = resolveMafiaTarget(state, registry);
  if (mafiaTarget && !blocked.has(mafiaTarget.actorId)) killAttempts.push({ ...mafiaTarget, attack: "basic" });
  for (const action of state.nightActions.filter((a) => a.actionType === "kill" && a.targetId)) {
    if (!blocked.has(action.actorId)) {
      const role = getRole(registry, state.players.find((p) => p.id === action.actorId)!.roleId);
      killAttempts.push({ actorId: action.actorId, targetId: action.targetId!, attack: role.attackTier ?? "basic" });
    }
  }
  const died = new Set<string>();
  for (const kill of killAttempts) {
    const defense = defenses[kill.targetId] ?? "none";
    const landed = ATTACK_RANK[kill.attack] > DEFENSE_RANK[defense];
    events.push({ type: "attackAttempted", day: state.day, actorId: kill.actorId, targetId: kill.targetId, attack: kill.attack, defense, outcome: landed ? "landed" : "failed" });
    if (landed) died.add(kill.targetId);
  }
  for (const playerId of died) {
    const player = state.players.find((p) => p.id === playerId);
    if (player?.alive) {
      player.alive = false;
      const role = getRole(registry, player.roleId);
      state.deaths.push({ playerId, roleId: player.roleId, alignment: role.alignment, day: state.day, phase: "night", cause: "night" });
      events.push({ type: "playerDied", playerId, roleId: player.roleId, cause: "night", day: state.day });
      state.cycleDeaths += 1;
    }
  }

  for (const action of state.nightActions.filter((a) => a.actionType === "investigate" && a.targetId)) {
    if (!blocked.has(action.actorId)) {
      const target = state.players.find((p) => p.id === action.targetId);
      if (target) {
        const role = getRole(registry, target.roleId);
        const isMafia = role.nightAction?.consensus === "mafia" && !role.passives?.investigationImmune;
        state.investigationResults.push({ day: state.day, actorId: action.actorId, targetId: target.id, isMafia });
        events.push({ type: "investigationResult", day: state.day, actorId: action.actorId, targetId: target.id, isMafia });
      }
    }
  }
  state.log.push(...events);
  state.nightActions = [];
  state.mafiaVotes = [];
  return state;
}
