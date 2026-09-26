// Single shared mafia-consensus resolver (Spec 08 §Lock-in — "do this
// FIRST"). Before this module existed, consensus/readiness logic was
// duplicated in three places (resolveMafiaTarget in resolve-night.ts,
// resolveConsensusReached/pendingNight in machine.ts, consensusReached in
// project.ts) — a `locked` filter applied to only some of them would have
// silently reverted the others to submit-only behavior. All three now route
// through `resolveConsensus`.
import type { MafiaVote, PlayerState } from "./types";
import type { MafiaConsensus } from "./ruleset";

// Spec 11 — the ONE generic lock-readiness helper, shared by BOTH day-vote
// readiness AND night individual-action readiness (do NOT fork a second lock
// system). It answers only "has each participant locked their own input"; it
// says nothing about WHAT they locked. Mafia factional CONSENSUS
// (unanimous/majority/designated agreement on a single target) is a distinct
// concern and stays in `resolveConsensus` on top of this.
//
// `participants`: the ids that must lock for the phase to be ready (living
// non-absent voters for the day; living non-absent individual night actors
// for the night). `submissions`: the current locked-state per participant
// (only ids present AND `locked` count). Absent/uncast/tentative → not locked.
export interface LockReadiness {
  allLocked: boolean;
  lockedCount: number;
}

export function lockReadiness(participants: string[], submissions: { id: string; locked: boolean }[]): LockReadiness {
  const lockedIds = new Set(submissions.filter((s) => s.locked).map((s) => s.id));
  const lockedCount = participants.filter((p) => lockedIds.has(p)).length;
  return { allLocked: participants.length > 0 ? lockedCount === participants.length : true, lockedCount };
}

export interface ConsensusResult {
  /** True once the readiness gate for this consensus mode holds: every
   * living non-absent killer has a qualifying vote (LOCKED, when
   * `lockedOnly`) — EXCEPT `designated` mode, where only the designated
   * killer's vote gates readiness (non-designated killers' state is
   * irrelevant here). This governs whether the night phase can advance —
   * it does NOT by itself imply a target was agreed; see `converged`. */
  ready: boolean;
  /** True iff a single target is actually agreed once `ready`: unanimous
   * requires every counted vote to name the same target (a locked-but-
   * disagreeing unanimous group is `ready && !converged` — "keep
   * deciding", per Spec 08); majority and designated always converge once
   * ready (a plurality/the designated pick always exists once votes are
   * locked). `converged` is always false while `!ready`. */
  converged: boolean;
  /** The resolved kill, present iff `converged`. */
  target: { actorId: string; targetId: string } | null;
}

function lowestSupportingKiller(
  votes: MafiaVote[],
  killers: PlayerState[],
  targetId: string,
  lockedOnly: boolean,
): PlayerState | undefined {
  const killerIds = new Set(killers.map((killer) => killer.id));
  return votes
    .filter((vote) => vote.targetId === targetId && killerIds.has(vote.playerId) && qualifies(vote, lockedOnly))
    .map((vote) => killers.find((killer) => killer.id === vote.playerId)!)
    .sort((a, b) => a.seat - b.seat)[0];
}

function compareTargetsBySupportingSeat(
  votes: MafiaVote[],
  killers: PlayerState[],
  lockedOnly: boolean,
): (a: [string, number], b: [string, number]) => number {
  return (a, b) => {
    const countDifference = b[1] - a[1];
    if (countDifference !== 0) return countDifference;
    const aSeat = lowestSupportingKiller(votes, killers, a[0], lockedOnly)?.seat ?? 9999;
    const bSeat = lowestSupportingKiller(votes, killers, b[0], lockedOnly)?.seat ?? 9999;
    return aSeat - bSeat || a[0].localeCompare(b[0]);
  };
}

function designatedKiller(killers: PlayerState[]): PlayerState | undefined {
  return killers.length === 0 ? undefined : [...killers].sort((a, b) => a.seat - b.seat)[0];
}

function qualifies(vote: MafiaVote | undefined, lockedOnly: boolean): vote is MafiaVote {
  return !!vote && vote.targetId !== null && (!lockedOnly || vote.locked);
}

/**
 * `votes`: the full mafia-vote record (state.mafiaVotes). `killers`: living,
 * non-absent mafia-consensus players (already filtered by mafiaKillers()).
 * `mode`: ruleset.mafiaConsensus. `opts.lockedOnly`: when true (the Spec 08
 * night-resolution reading gate), only `locked:true` votes count toward
 * both readiness and the tally.
 */
export function resolveConsensus(votes: MafiaVote[], killers: PlayerState[], mode: MafiaConsensus, opts: { lockedOnly: boolean }): ConsensusResult {
  if (killers.length === 0) return { ready: true, converged: false, target: null };

  if (mode === "designated") {
    const designated = designatedKiller(killers)!;
    const vote = votes.find((v) => v.playerId === designated.id);
    const ready = qualifies(vote, opts.lockedOnly);
    return { ready, converged: ready, target: ready ? { actorId: designated.id, targetId: vote!.targetId! } : null };
  }

  const ready = killers.every((k) => qualifies(votes.find((v) => v.playerId === k.id), opts.lockedOnly));
  if (!ready) return { ready, converged: false, target: null };

  const relevantVotes = votes.filter((v) => killers.some((k) => k.id === v.playerId) && qualifies(v, opts.lockedOnly));
  const counts = new Map<string, number>();
  for (const vote of relevantVotes) counts.set(vote.targetId!, (counts.get(vote.targetId!) ?? 0) + 1);
  const sorted = [...counts.entries()].sort(compareTargetsBySupportingSeat(relevantVotes, killers, opts.lockedOnly));
  const top = sorted[0]!;
  const converged = mode === "unanimous" ? top[1] === killers.length : true;
  const actor = lowestSupportingKiller(relevantVotes, killers, top[0], opts.lockedOnly);
  const target = converged && actor ? { actorId: actor.id, targetId: top[0] } : null;

  return { ready, converged, target };
}

/** Force-advance/timer fallback (Spec 08 amends Spec 02 v2.3: "plurality
 * among submitted" -> "plurality among locked"): resolve strictly from
 * LOCKED votes, by plurality (ties by seat order); zero locked -> no kill.
 * Used regardless of the ruleset's consensus mode or `resolveConsensus`'s
 * own readiness/convergence state — the whole point of this fallback is
 * that normal resolution didn't (or might not) naturally converge, so
 * `designated` mode also falls back to plurality-among-locked here, not
 * just the designated seat. */
export function resolveLockedPlurality(votes: MafiaVote[], killers: PlayerState[]): { actorId: string; targetId: string } | null {
  if (killers.length === 0) return null;
  const killerIds = new Set(killers.map((p) => p.id));
  const lockedVotes = votes.filter((v) => killerIds.has(v.playerId) && v.targetId !== null && v.locked);
  if (lockedVotes.length === 0) return null;
  const counts = new Map<string, number>();
  for (const vote of lockedVotes) counts.set(vote.targetId!, (counts.get(vote.targetId!) ?? 0) + 1);
  const sorted = [...counts.entries()].sort(compareTargetsBySupportingSeat(lockedVotes, killers, true));
  const top = sorted[0]!;
  const actor = lowestSupportingKiller(lockedVotes, killers, top[0], true)!;
  return { actorId: actor.id, targetId: top[0] };
}
