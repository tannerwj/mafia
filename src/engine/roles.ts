import type { Alignment, AttackTier, CountsForParityAs, DefenseTier, GameEvent, GameState, NightActionType, PlayerId, RoleId } from "./types";

export interface NightActionSpec {
  actionType: NightActionType;
  priorityBand: 100 | 200 | 300 | 400 | 450 | 500;
  targetRule: "living-other" | "living-any" | "any";
  consensus?: "mafia";
  // Spec 11: the inert decoy. `activeNightActionFor` synthesizes one of these
  // for any living non-absent player whose role has no real `nightAction`, so
  // every living player performs the same pick→confirm shape at night. A
  // decoy `"watch"` creates NO visit any resolver observes (every
  // resolve-night.ts filter is an allow-list). Never authored on a real role.
  decoy?: boolean;
}

// Spec 11: the synthetic decoy spec handed to no-action roles. `living-other`
// so the picker matches the detective's shape (pick another living player);
// `priorityBand` is arbitrary — the resolver never reads a `"watch"` action.
const DECOY_WATCH_SPEC: NightActionSpec = {
  actionType: "watch",
  priorityBand: 100,
  targetRule: "living-other",
  decoy: true,
};

export interface RoleDef {
  id: RoleId;
  displayName: string;
  alignment: Alignment;
  countsForParityAs: CountsForParityAs;
  nightAction?: NightActionSpec;
  passives?: {
    investigationImmune?: boolean;
  };
  knowledgeAtStart?: "mafia" | "mafia-partners";
  attackTier?: AttackTier;
  defenseTier?: DefenseTier;
  winHook?: (state: GameState, event: GameEvent) => string[] | null;
}

export type RoleRegistry = Record<RoleId, RoleDef>;

export const HOUSE_ROLE_DEFS = {
  villager: {
    id: "villager",
    displayName: "Villager",
    alignment: "town",
    countsForParityAs: "village",
  },
  mafia: {
    id: "mafia",
    displayName: "Mafia",
    alignment: "mafia",
    countsForParityAs: "mafia",
    knowledgeAtStart: "mafia-partners",
    nightAction: { actionType: "mafiaKill", priorityBand: 400, targetRule: "living-other", consensus: "mafia" },
    attackTier: "basic",
  },
  detective: {
    id: "detective",
    displayName: "Detective",
    alignment: "town",
    countsForParityAs: "village",
    nightAction: { actionType: "investigate", priorityBand: 500, targetRule: "living-other" },
  },
  angel: {
    id: "angel",
    displayName: "Angel",
    alignment: "town",
    countsForParityAs: "village",
    nightAction: { actionType: "protect", priorityBand: 300, targetRule: "living-any" },
  },
  suicide_bomber: {
    id: "suicide_bomber",
    displayName: "Suicide Bomber",
    alignment: "neutral",
    countsForParityAs: "village",
    winHook: (_state, event) => event.type === "playerDied" && event.cause === "vote" && event.roleId === "suicide_bomber" ? ["suicide_bomber"] : null,
  },
  minion: {
    id: "minion",
    displayName: "Minion",
    alignment: "mafia",
    countsForParityAs: "mafia",
    knowledgeAtStart: "mafia",
  },
} satisfies RoleRegistry;

// The active registry for the current game, set once by `startGame(..., roles?)`
// and read by every subsequent `applyCommand`/`projectFor` call against that
// state (registries hold functions, e.g. `winHook`, so they cannot live inside
// the JSON-serializable `GameState` itself). This replaces the old exported
// `registerRoles` mutator: the only way to configure roles is through
// `startGame`, not ambient mutation from arbitrary call sites.
let activeRegistry: RoleRegistry = HOUSE_ROLE_DEFS;

export function configureRoles(roles: RoleRegistry | undefined): RoleRegistry {
  activeRegistry = roles ?? HOUSE_ROLE_DEFS;
  return activeRegistry;
}

export function currentRoles(): RoleRegistry {
  return activeRegistry;
}

export function getRole(registry: RoleRegistry, roleId: RoleId): RoleDef {
  const role = registry[roleId];
  if (!role) throw new Error(`Unknown role: ${roleId}`);
  return role;
}

// Spec 11: every living, non-absent player has a night input now. A role with
// a real `nightAction` returns that spec (unless it's the mafiaKill suppressed
// on a firstNightKill=false night 1 — those killers then fall through to the
// decoy, so they still pick→confirm and the night stays uniform); a role with
// no real night action returns the synthetic decoy `"watch"` spec.
export function activeNightActionFor(state: GameState, registry: RoleRegistry, playerId: PlayerId): NightActionSpec | undefined {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !player.alive || player.absent) return undefined;
  const role = registry[player.roleId];
  const real = role?.nightAction;
  if (real && !(real.actionType === "mafiaKill" && !state.ruleset.firstNightKill && state.day === 1)) {
    return real;
  }
  return DECOY_WATCH_SPEC;
}

// Spec 11: an INDIVIDUAL (non-mafia-consensus) night input this player owes —
// a real individual action OR the decoy. Mafia consensus is gated separately
// (mafiaKillers + resolveConsensus), so it is excluded here. Returns true for
// decoy roles so they count toward night readiness.
export function hasNightInput(state: GameState, registry: RoleRegistry, playerId: PlayerId): boolean {
  const spec = activeNightActionFor(state, registry, playerId);
  if (!spec) return false;
  if (spec.consensus === "mafia") return false;
  return true;
}

export function mafiaKillers(state: GameState, registry: RoleRegistry) {
  if (!state.ruleset.firstNightKill && state.day === 1) return [];
  return state.players.filter((p) => {
    const role = registry[p.roleId];
    return p.alive && !p.absent && role?.nightAction?.consensus === "mafia";
  });
}

export function canSubmitMafiaVote(state: GameState, registry: RoleRegistry, playerId: PlayerId): boolean {
  return mafiaKillers(state, registry).some((p) => p.id === playerId);
}

export function roleOrder(alignment: Alignment): number {
  return alignment === "neutral" ? 0 : alignment === "mafia" ? 1 : 2;
}
