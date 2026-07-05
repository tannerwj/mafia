import { ATTACK_RANK, DEFENSE_RANK, type DefenseTier, type GameEvent, type GameState, type SubmittedAction } from "./types";
import { getRole, mafiaKillers, roleOrder, type RoleRegistry } from "./roles";
import { resolveConsensus, resolveLockedPlurality } from "./consensus";

function defenseMax(a: DefenseTier, b: DefenseTier): DefenseTier {
  return DEFENSE_RANK[a] >= DEFENSE_RANK[b] ? a : b;
}

function submitted(state: GameState, actorId: string, type?: string): SubmittedAction | undefined {
  return state.nightActions.find((a) => a.actorId === actorId && (!type || a.actionType === type));
}

/**
 * `forced`: false (default) for the natural zero-pending-input advance —
 * resolves via the ruleset's own consensus mode (`resolveConsensus`'s
 * `converged` target; unanimous disagreement yields no kill even though
 * this is only reachable once all killers are locked, since machine.ts's
 * readiness gate wouldn't have allowed the phase to advance naturally on a
 * disagreement). `forced: true` is the force-advance/timerExpired fallback
 * (Spec 08 amends Spec 02 v2.3): resolves strictly from LOCKED votes by
 * plurality regardless of mode or convergence — this is what lets a host
 * break a unanimous-mode deadlock or an under-locked majority/designated
 * group.
 */
export function resolveMafiaTarget(state: GameState, registry: RoleRegistry, forced = false): { actorId: string; targetId: string } | null {
  const killers = mafiaKillers(state, registry);
  if (forced) return resolveLockedPlurality(state.mafiaVotes, killers);
  return resolveConsensus(state.mafiaVotes, killers, state.ruleset.mafiaConsensus, { lockedOnly: true }).target;
}

function seatOf(state: GameState, playerId: string): number {
  return state.players.find((p) => p.id === playerId)?.seat ?? 9999;
}

export function resolveNight(input: GameState, registry: RoleRegistry, forced = false): GameState {
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
  const mafiaTarget = resolveMafiaTarget(state, registry, forced);
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
