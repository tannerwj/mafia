// Snapshot-facing types shared by the engine and the client. This module
// defines these types standalone (zero imports from src/engine) — the
// dependency points engine -> shared, never the reverse.

export type RoleId = string;
export type PlayerId = string;
export type Phase = "night" | "dawn" | "day" | "runoff" | "dusk" | "ended";
export type AttackTier = "basic" | "powerful" | "unstoppable";
export type DefenseTier = "none" | "basic" | "powerful" | "invincible";
// `"watch"` (Spec 11) is the inert decoy action: a no-action role
// (villager/minion/bomber) picks a living player to "keep an eye on" and
// confirms it, so every living player performs the same pick→confirm shape at
// night (kills the "only power roles tap" tell). It creates NO visit any
// current resolver observes — every resolve-night.ts filter is an ALLOW-LIST,
// so `"watch"` is ignored by construction. Its target is PRIVATE (filtered
// from every non-host projection).
export type NightActionType = "mafiaKill" | "protect" | "investigate" | "roleblock" | "kill" | "watch";
export type VoteTarget = PlayerId | "no_murder";

export type GameEvent =
  | { type: "gameStarted"; roleAssignments: { playerId: PlayerId; roleId: RoleId }[] }
  | { type: "phaseChanged"; phase: Phase; day: number; phaseGen: number }
  | { type: "actionSubmitted"; actorId: PlayerId; actionType: NightActionType; targetId: PlayerId | null; day: number }
  | { type: "actionLocked"; actorId: PlayerId; day: number }
  | { type: "actionUnlocked"; actorId: PlayerId; day: number }
  | { type: "voteCast"; voterId: PlayerId; target: VoteTarget; day: number; phase: Phase }
  | { type: "voteRetracted"; voterId: PlayerId; day: number; phase: Phase }
  | { type: "voteLocked"; voterId: PlayerId; day: number; phase: Phase }
  | { type: "voteUnlocked"; voterId: PlayerId; day: number; phase: Phase }
  | { type: "acknowledged"; playerId: PlayerId; day: number }
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
  /** Host-only, night/runoff-action-phase-only (Spec 02 v2.7). Has this seat
   * discharged the individual night action or mafia-consensus kill-vote it
   * owes this phase? Present ONLY for seats that owe an action this phase
   * (an individual night-action role, or a living non-absent mafia-consensus
   * participant) — `undefined` for non-actors (villager/minion/bomber-style
   * roles), never `false` for them, so the UI can render "asleep" instead of
   * a fabricated "pending". Absent entirely for player/public/dead-god-view
   * projections — this is a live-pending-action signal, and Spec 02's dead
   * god view is deliberately resolved-only (no current-phase pending leak).
   * Spec 08 v2.8 AMENDS this for mafia: a killer counts as `acted` only once
   * LOCKED (a tentative pick is still `false`/pending) — non-mafia
   * individual actors are unaffected (still `acted` = submitted). */
  acted?: boolean;
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
    /** Spec 08 (amends v2.6, BREAKING shape change): now covers ALL living,
     * non-absent killers (undecided -> targetId null), not just those who've
     * already picked — `factionVotes.length` is the killer count, never a
     * picked-count proxy. Each entry gains `locked`. */
    factionVotes?: { voterId: PlayerId; targetId: PlayerId | null; locked: boolean }[];
    /** Killers currently locked (Spec 08). */
    lockedCount?: number;
    /** Spec 08 REDEFINES this: true iff all relevant killers are locked AND
     * the ruleset's consensus rule is satisfied (previously unrelated to
     * locking). */
    consensusReached?: boolean;
    mafiaRoster?: PlayerId[];
    currentVote?: VoteTarget;
    /** Spec 11: whether the viewer's own day vote is LOCKED (confirmed). A
     * cast vote is tentative (`false`) until `confirm_vote`; the day phase
     * resolves only when every living player is locked. Present for a living
     * viewer during day/runoff whenever they have a standing vote. */
    dayVoteLocked?: boolean;
    /** Spec 11: whether the viewer's own night submission is LOCKED
     * (confirmed) — for the universal pick→confirm flow (real actions AND the
     * decoy "watch"). Present for a living viewer with a night input during
     * night. Mafia use `factionVotes[].locked` instead (this stays undefined
     * for them). */
    nightActionLocked?: boolean;
    /** Spec 11: true iff the viewer's role has a night input this phase but
     * it is the inert decoy (`"watch"`) — lets the UI render the "keep an eye
     * on someone" panel. Never reveals another player's decoy. */
    nightIsDecoy?: boolean;
    /** Spec 11: whether the viewer has acknowledged the current dawn Morning
     * Report (`acknowledge`). Present during dawn for a living viewer. */
    acknowledged?: boolean;
  };
  votes?: { playerId: PlayerId; target: VoteTarget }[];
  voted?: PlayerId[];
  runoffCandidates?: PlayerId[];
  log: GameEvent[];
  winners: string[] | null;
}
