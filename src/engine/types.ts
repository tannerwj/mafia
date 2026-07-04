import type {
  AttackTier,
  DefenseTier,
  GameEvent,
  NightActionType,
  Phase,
  PlayerId,
  RoleId,
  VoteTarget,
} from "../shared/game-view";

export type { AttackTier, DefenseTier, GameEvent, NightActionType, Phase, PlayerId, RoleId, VoteTarget };
export type Alignment = "town" | "mafia" | "neutral";
export type CountsForParityAs = "village" | "mafia";

export interface LobbyPlayer {
  id: PlayerId;
  name?: string;
}

export interface PlayerState {
  id: PlayerId;
  seat: number;
  roleId: RoleId;
  alive: boolean;
  absent: boolean;
}

export interface SubmittedAction {
  actorId: PlayerId;
  actionType: NightActionType;
  targetId: PlayerId | null;
}

export interface InvestigationResult {
  day: number;
  actorId: PlayerId;
  targetId: PlayerId;
  isMafia: boolean;
}

export interface DeathRecord {
  playerId: PlayerId;
  roleId: RoleId;
  alignment: Alignment;
  day: number;
  phase: Phase;
  cause: "night" | "vote";
}

export interface GameState {
  phase: Phase;
  day: number;
  players: PlayerState[];
  ruleset: import("./ruleset").Ruleset;
  rngState: number;
  deadlineAt: number | null;
  phaseGen: number;
  log: GameEvent[];
  nightActions: SubmittedAction[];
  mafiaVotes: { playerId: PlayerId; targetId: PlayerId | null }[];
  votes: { playerId: PlayerId; target: VoteTarget }[];
  runoffCandidates: PlayerId[] | null;
  investigationResults: InvestigationResult[];
  deaths: DeathRecord[];
  winners: string[] | null;
  cycleDeaths: number;
}

export type Command =
  | { type: "submitAction"; playerId: PlayerId; actionType?: NightActionType; targetId: PlayerId | null; now?: number }
  | { type: "castVote"; playerId: PlayerId; target: VoteTarget; now?: number }
  | { type: "retractVote"; playerId: PlayerId; now?: number }
  | { type: "forceAdvance"; byHost?: boolean; gen: number; now?: number }
  | { type: "timerExpired"; at: number; now?: number }
  | { type: "markAbsent"; byHost?: boolean; playerId: PlayerId; now?: number }
  | { type: "markPresent"; byHost?: boolean; playerId: PlayerId; now?: number };

export type Effect =
  | { type: "setDeadline"; at: number }
  | { type: "clearDeadline" }
  | { type: "gameEnded"; winners: string[] };

export interface Rejection {
  code: string;
  playerId?: PlayerId;
}

export interface EngineResult {
  state: GameState;
  effects: Effect[];
  rejection?: Rejection;
}

export const ATTACK_RANK: Record<AttackTier, number> = { basic: 1, powerful: 2, unstoppable: 3 };
export const DEFENSE_RANK: Record<DefenseTier, number> = { none: 0, basic: 1, powerful: 2, invincible: 3 };
