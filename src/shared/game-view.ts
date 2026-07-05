// Snapshot-facing types shared by the engine and the client. This module
// defines these types standalone (zero imports from src/engine) — the
// dependency points engine -> shared, never the reverse.

export type RoleId = string;
export type PlayerId = string;
export type Phase = "night" | "dawn" | "day" | "runoff" | "dusk" | "ended";
export type AttackTier = "basic" | "powerful" | "unstoppable";
export type DefenseTier = "none" | "basic" | "powerful" | "invincible";
export type NightActionType = "mafiaKill" | "protect" | "investigate" | "roleblock" | "kill";
export type VoteTarget = PlayerId | "no_murder";

export type GameEvent =
  | { type: "gameStarted"; roleAssignments: { playerId: PlayerId; roleId: RoleId }[] }
  | { type: "phaseChanged"; phase: Phase; day: number; phaseGen: number }
  | { type: "actionSubmitted"; actorId: PlayerId; actionType: NightActionType; targetId: PlayerId | null; day: number }
  | { type: "voteCast"; voterId: PlayerId; target: VoteTarget; day: number; phase: Phase }
  | { type: "voteRetracted"; voterId: PlayerId; day: number; phase: Phase }
  | { type: "attackAttempted"; day: number; actorId: PlayerId; targetId: PlayerId; attack: AttackTier; defense: DefenseTier; outcome: "landed" | "failed" }
  | { type: "playerDied"; playerId: PlayerId; roleId: RoleId; cause: "night" | "vote"; day: number }
  | { type: "investigationResult"; day: number; actorId: PlayerId; targetId: PlayerId; isMafia: boolean }
  | { type: "runoffStarted"; candidates: PlayerId[]; day: number }
  | { type: "voteResolved"; eliminatedId: PlayerId | null; day: number; reason: string }
  | { type: "playerAbsent"; playerId: PlayerId }
  | { type: "playerPresent"; playerId: PlayerId }
  | { type: "gameEnded"; winners: string[]; reason: string };

export type Viewer = { kind: "player"; id: PlayerId } | { kind: "host" } | { kind: "public" };

export interface ClientGamePlayer {
  id: PlayerId;
  alive: boolean;
  absent: boolean;
  roleId?: RoleId;
  alignment?: string;
}

export interface ClientGameView {
  phase: Phase;
  day: number;
  deadlineAt: number | null;
  phaseGen: number;
  players: ClientGamePlayer[];
  you?: {
    playerId: PlayerId;
    alive: boolean;
    roleId?: RoleId;
    pendingAction?: { actionType: string; targetId: PlayerId | null };
    investigationResults?: { day: number; targetId: PlayerId; isMafia: boolean }[];
    factionVotes?: { playerId: PlayerId; targetId: PlayerId | null }[];
    consensusReached?: boolean;
    mafiaRoster?: PlayerId[];
    currentVote?: VoteTarget;
  };
  votes?: { playerId: PlayerId; target: VoteTarget }[];
  voted?: PlayerId[];
  runoffCandidates?: PlayerId[];
  log: GameEvent[];
  winners: string[] | null;
}
