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
  // Spec 11: individual night actions are now pick→confirm too. `locked`
  // gates night readiness the same way a mafia vote's `locked` does — a
  // tentative (unlocked) individual pick never makes the night ready.
  locked: boolean;
}

export interface MafiaVote {
  playerId: PlayerId;
  targetId: PlayerId | null;
  locked: boolean;
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
  mafiaVotes: MafiaVote[];
  // Spec 11: a day vote is tentative (`locked:false`) on `castVote`, and
  // `confirmVote` locks it. The phase resolves only when every living
  // non-absent player is LOCKED (see `pendingVotes`).
  votes: { playerId: PlayerId; target: VoteTarget; locked: boolean }[];
  runoffCandidates: PlayerId[] | null;
  investigationResults: InvestigationResult[];
  deaths: DeathRecord[];
  winners: string[] | null;
  cycleDeaths: number;
  // Spec 11: player ids that have acknowledged the CURRENT dawn Morning
  // Report. Reset on every phase transition (a fresh dawn starts empty). Dawn
  // advances to day once every living player has acknowledged (or the beat
  // backstop elapses, or the host force-advances).
  acknowledgedBy: PlayerId[];
}

export type Command =
  | { type: "submitAction"; playerId: PlayerId; actionType?: NightActionType; targetId: PlayerId | null; now?: number }
  | { type: "castVote"; playerId: PlayerId; target: VoteTarget; now?: number }
  | { type: "retractVote"; playerId: PlayerId; now?: number }
  // Spec 11: confirm/unconfirm the sender's tentative DAY vote.
  | { type: "confirmVote"; playerId: PlayerId; now?: number }
  | { type: "unconfirmVote"; playerId: PlayerId; now?: number }
  // Spec 08/11: lock/unlock a NIGHT submission. Generalized in Spec 11 to
  // cover BOTH a mafia-consensus kill vote AND an individual night action
  // (real or the inert decoy "watch") — the same pick→confirm shape for
  // every living player.
  | { type: "lockAction"; playerId: PlayerId; now?: number }
  | { type: "unlockAction"; playerId: PlayerId; now?: number }
  // Spec 11: acknowledge the current dawn Morning Report. `gen` is
  // phaseGen-guarded (like forceAdvance) — a stale ack no-ops.
  | { type: "acknowledge"; playerId: PlayerId; gen: number; now?: number }
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
