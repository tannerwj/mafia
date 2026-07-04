import { getRole, type RoleRegistry } from "./roles";
import type { GameEvent, GameState, PlayerState } from "./types";

function living(state: GameState): PlayerState[] {
  return state.players.filter((p) => p.alive);
}

export function evaluateWin(state: GameState, registry: RoleRegistry, event?: GameEvent): { winners: string[]; reason: string } | null {
  if (event) {
    for (const player of state.players) {
      const role = registry[player.roleId];
      const hook = role?.winHook?.(state, event);
      if (hook) return { winners: hook, reason: "win_hook" };
    }
  }

  const alive = living(state);
  const mafiaRoles = alive.filter((p) => getRole(registry, p.roleId).nightAction?.consensus === "mafia").length;
  const minions = alive.filter((p) => p.roleId === "minion").length;
  if (mafiaRoles === 0 && minions === 0) return { winners: ["village"], reason: "village" };

  const mafiaTeam = alive.filter((p) => getRole(registry, p.roleId).countsForParityAs === "mafia").length;
  const everyoneElse = alive.length - mafiaTeam;
  const parity = mafiaTeam >= everyoneElse;
  if (state.ruleset.parityRule === "immediate" && parity) return { winners: ["mafia"], reason: "parity" };
  if (state.ruleset.parityRule === "elimination") {
    if (everyoneElse === 0) return { winners: ["mafia"], reason: "elimination" };
    if (parity && state.cycleDeaths === 0 && state.phase === "dawn" && state.day > 1) return { winners: ["mafia"], reason: "anti_stall" };
  }
  return null;
}
