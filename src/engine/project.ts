import type { ClientGameView, Viewer } from "../shared/game-view";
import { activeNightActionFor, canSubmitMafiaVote, currentRoles, getRole, mafiaKillers } from "./roles";
import type { GameEvent, GameState } from "./types";

function revealForPublic(state: GameState, playerId: string) {
  const death = state.deaths.find((d) => d.playerId === playerId);
  if (!death) return {};
  if (state.phase === "ended" || state.ruleset.revealOnDeath === "full") return { roleId: death.roleId, alignment: death.alignment };
  if (state.ruleset.revealOnDeath === "alignment") return { alignment: death.alignment };
  return {};
}

function hiddenVotingFilter(state: GameState, event: GameEvent, god: boolean): boolean {
  if (god || state.ruleset.votingVisibility === "realtime" || state.phase === "dusk" || state.phase === "ended") return true;
  return event.type !== "voteCast" && event.type !== "voteRetracted";
}

function resolvedLog(state: GameState, god: boolean): GameEvent[] {
  const log = god ? state.log : state.log.filter((e) => e.type !== "actionSubmitted");
  return log.filter((e) => hiddenVotingFilter(state, e, god));
}

// Host-only, night-phase-only per-seat "acted" signal (Spec 02 v2.7). Only
// seats that OWE an action this phase get a defined value — an individual
// night-action role (via `activeNightActionFor`, which already excludes
// dead/absent players and gates mafiaKill on `firstNightKill` night 1) or a
// living, non-absent mafia-consensus killer (`canSubmitMafiaVote`).
// Non-actors (villager/minion/bomber-style roles, or a dead/absent seat with
// no owed action) get `undefined` — never a fabricated `false` — so the host
// table can render "asleep"/"—" instead of a false "pending".
function actedThisNight(state: GameState, playerId: string): boolean | undefined {
  const registry = currentRoles();
  const spec = activeNightActionFor(state, registry, playerId);
  if (spec && spec.consensus !== "mafia") {
    return state.nightActions.some((a) => a.actorId === playerId);
  }
  if (canSubmitMafiaVote(state, registry, playerId)) {
    const vote = state.mafiaVotes.find((v) => v.playerId === playerId);
    return !!vote && vote.targetId !== null;
  }
  return undefined;
}

function consensusReached(state: GameState): boolean {
  const killers = mafiaKillers(state, currentRoles());
  if (killers.length === 0) return true;
  const votes = state.mafiaVotes.filter((v) => killers.some((p) => p.id === v.playerId) && v.targetId);
  if (votes.length === 0) return false;
  if (state.ruleset.mafiaConsensus === "designated") return votes.some((v) => v.playerId === killers.sort((a, b) => a.seat - b.seat)[0]!.id);
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote.targetId!, (counts.get(vote.targetId!) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return state.ruleset.mafiaConsensus === "unanimous" ? top === killers.length : top > killers.length / 2;
}

export function projectFor(state: GameState, viewer: Viewer): ClientGameView {
  const viewerPlayer = viewer.kind === "player" ? state.players.find((p) => p.id === viewer.id) : undefined;
  const god = viewer.kind === "host" || (!!viewerPlayer && !viewerPlayer.alive) || state.phase === "ended";
  const hostLive = viewer.kind === "host";
  const view: ClientGameView = {
    phase: state.phase,
    day: state.day,
    deadlineAt: state.deadlineAt,
    phaseGen: state.phaseGen,
    players: state.players.map((p) => {
      const role = getRole(currentRoles(), p.roleId);
      const visible = god ? { roleId: p.roleId, alignment: role.alignment } : revealForPublic(state, p.id);
      // Host-only, night-phase-only (Spec 02 v2.7) — never computed for
      // player/public projections, so there is no pending-action leak to
      // guard against on those paths (the field simply never exists there).
      const acted =
        hostLive && state.phase === "night" ? actedThisNight(state, p.id) : undefined;
      return {
        id: p.id,
        alive: p.alive,
        absent: p.absent,
        ...visible,
        ...(acted !== undefined ? { acted } : {}),
      };
    }),
    log: resolvedLog(state, hostLive),
    winners: state.winners,
  };
  if (state.runoffCandidates) view.runoffCandidates = state.runoffCandidates;
  if (state.ruleset.votingVisibility === "realtime" || god || state.phase === "dusk" || state.phase === "ended") view.votes = state.votes;
  else view.voted = state.votes.map((v) => v.playerId);
  if (viewerPlayer) {
    const role = getRole(currentRoles(), viewerPlayer.roleId);
    const you: NonNullable<ClientGameView["you"]> = { playerId: viewerPlayer.id, alive: viewerPlayer.alive, roleId: viewerPlayer.roleId };
    const pending = state.nightActions.find((a) => a.actorId === viewerPlayer.id);
    const mafiaVote = state.mafiaVotes.find((v) => v.playerId === viewerPlayer.id);
    if (pending) you.pendingAction = { actionType: pending.actionType, targetId: pending.targetId };
    if (mafiaVote) you.pendingAction = { actionType: "mafiaKill", targetId: mafiaVote.targetId };
    if (role.nightAction?.consensus === "mafia" && state.phase === "night") {
      you.factionVotes = state.mafiaVotes.filter((v) => mafiaKillers(state, currentRoles()).some((p) => p.id === v.playerId));
      you.consensusReached = consensusReached(state);
    }
    if (viewerPlayer.roleId === "detective") {
      you.investigationResults = state.investigationResults.filter((r) => r.actorId === viewerPlayer.id).map((r) => ({ day: r.day, targetId: r.targetId, isMafia: r.isMafia }));
    }
    if (viewerPlayer.alive && (role.knowledgeAtStart === "mafia" || role.knowledgeAtStart === "mafia-partners")) {
      // Role-identity knowledge ("who is on the mafia team"), not a live
      // action tally — unlike `mafiaKillers` (used for consensus/kill
      // eligibility), this must not hide entries for absent players, dead
      // partners, or on a firstNightKill=false night 1.
      you.mafiaRoster = state.players
        .filter((p) => p.id !== viewerPlayer.id && getRole(currentRoles(), p.roleId).nightAction?.consensus === "mafia")
        .map((p) => p.id);
    }
    if (viewerPlayer.alive) {
      const vote = state.votes.find((v) => v.playerId === viewerPlayer.id);
      if (vote) you.currentVote = vote.target;
    }
    view.you = you;
  }
  return view;
}
