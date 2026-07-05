// Single shared mafia-consensus resolver (Spec 08 §Lock-in — "do this
// FIRST"). Before this module existed, consensus/readiness logic was
// duplicated in three places (resolveMafiaTarget in resolve-night.ts,
// resolveConsensusReached/pendingNight in machine.ts, consensusReached in
// project.ts) — a `locked` filter applied to only some of them would have
// silently reverted the others to submit-only behavior. All three now route
// through `resolveConsensus`.
import type { MafiaVote, PlayerState } from "./types";
import type { MafiaConsensus } from "./ruleset";

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

function seatOf(killers: PlayerState[], playerId: string): number {
  return killers.find((p) => p.id === playerId)?.seat ?? 9999;
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
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || seatOf(killers, a[0]) - seatOf(killers, b[0]));
  const top = sorted[0]!;
  const converged = mode === "unanimous" ? top[1] === killers.length : true;
  const target = converged ? { actorId: relevantVotes.find((v) => v.targetId === top[0])!.playerId, targetId: top[0] } : null;

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
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || seatOf(killers, a[0]) - seatOf(killers, b[0]));
  const top = sorted[0]!;
  return { actorId: lockedVotes.find((v) => v.targetId === top[0])!.playerId, targetId: top[0] };
}
