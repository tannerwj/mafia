import type { ClientGameView, Viewer } from "../shared/game-view";
import { activeNightActionFor, canSubmitMafiaVote, currentRoles, getRole, hasNightInput, mafiaKillers } from "./roles";
import { resolveConsensus } from "./consensus";
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
  // Spec 11: `voteLocked`/`voteUnlocked` are the confirm-step analog of
  // `voteCast`/`voteRetracted` — same hidden-voting sealing (they'd leak who
  // has locked, a per-seat signal).
  return (
    event.type !== "voteCast" &&
    event.type !== "voteRetracted" &&
    event.type !== "voteLocked" &&
    event.type !== "voteUnlocked"
  );
}

function resolvedLog(state: GameState, god: boolean): GameEvent[] {
  // Spec 11: `actionSubmitted` (any type, incl. the decoy `"watch"`) and
  // `acknowledged` are per-seat action signals — stripped for non-god viewers
  // so a player never sees who acted/acknowledged (the no-pending-count leak
  // ban extends to the log, not just aggregate fields).
  const log = god
    ? state.log
    : state.log.filter((e) => e.type !== "actionSubmitted" && e.type !== "acknowledged");
  return log.filter((e) => hiddenVotingFilter(state, e, god));
}

// Host-only, night-phase-only per-seat "acted" signal (Spec 02 v2.7). Only
// seats that OWE an action this phase get a defined value — an individual
// night-action role (via `activeNightActionFor`, which already excludes
// dead/absent players and gates mafiaKill on `firstNightKill` night 1) or a
// living, non-absent mafia-consensus killer (`canSubmitMafiaVote`).
// Non-actors (villager/minion/bomber-style roles, or a dead/absent seat with
// no owed action) get `undefined` — never a fabricated `false` — so the host
// table can render "asleep"/"—" instead of a false "pending". Spec 08 v2.8
// amends the mafia branch: a killer counts as `acted` only once LOCKED (a
// tentative pick is still pending) — non-mafia actors are unaffected.
function actedThisNight(state: GameState, playerId: string): boolean | undefined {
  const registry = currentRoles();
  if (canSubmitMafiaVote(state, registry, playerId)) {
    const vote = state.mafiaVotes.find((v) => v.playerId === playerId);
    return !!vote && vote.targetId !== null && vote.locked;
  }
  // Spec 11: individual night input (real action OR decoy `"watch"`) — every
  // living non-absent non-mafia seat now owes one, so the host sees per-seat
  // acted/pending for the whole table (no seat is `undefined`/asleep at night
  // anymore). Uniform with mafia: `acted` only once LOCKED (a tentative pick
  // is still pending).
  if (hasNightInput(state, registry, playerId)) {
    const action = state.nightActions.find((a) => a.actorId === playerId);
    return !!action && action.targetId !== null && action.locked;
  }
  return undefined;
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
  // Spec 11 no-pending-count leak ban: a plain (hidden-voting, non-god) player
  // sees NEITHER the full ballots NOR a `voted` id list — that list is a
  // per-seat "who has voted" signal (a denominator in disguise). Only realtime
  // rooms (an explicit ruleset opt-in) expose ballots to players, and only the
  // god view (host / dead / ended) sees the full tally. A player learns their
  // own vote/lock state solely through `you.currentVote`/`you.dayVoteLocked`.
  if (state.ruleset.votingVisibility === "realtime" || god || state.phase === "dusk" || state.phase === "ended") view.votes = state.votes;
  if (viewerPlayer) {
    const role = getRole(currentRoles(), viewerPlayer.roleId);
    const you: NonNullable<ClientGameView["you"]> = { playerId: viewerPlayer.id, alive: viewerPlayer.alive, roleId: viewerPlayer.roleId };
    const pending = state.nightActions.find((a) => a.actorId === viewerPlayer.id);
    const mafiaVote = state.mafiaVotes.find((v) => v.playerId === viewerPlayer.id);
    // The viewer's OWN submission (incl. their own decoy `"watch"` target) is
    // fine to reflect back to them — it's only other players' decoys that
    // must stay private, and those never appear on `you`. Spec 11: expose the
    // individual lock state + whether this player's night input is the decoy,
    // so the UI can render the "keep an eye on someone" panel + confirm.
    if (pending) {
      you.pendingAction = { actionType: pending.actionType, targetId: pending.targetId };
      you.nightActionLocked = pending.locked;
    }
    if (mafiaVote) you.pendingAction = { actionType: "mafiaKill", targetId: mafiaVote.targetId };
    if (viewerPlayer.alive && state.phase === "night") {
      const spec = activeNightActionFor(state, currentRoles(), viewerPlayer.id);
      if (spec?.decoy) you.nightIsDecoy = true;
    }
    // `viewerPlayer.alive` guard: a dead ex-mafia's god view is
    // resolved-only (Spec 02 v2.2) — this field must not leak live
    // teammate tentative/locked picks for the still-unresolved current
    // night to a player who is now dead (their own re-projection after
    // death still carries `roleId: "mafia"`, so the role/phase check alone
    // is not sufficient).
    if (viewerPlayer.alive && role.nightAction?.consensus === "mafia" && state.phase === "night") {
      const killers = mafiaKillers(state, currentRoles());
      // Spec 08 (amends v2.6, BREAKING shape): covers ALL living non-absent
      // killers, undecided -> targetId null, not just those who've already
      // picked — `factionVotes.length` is the killer count now, never a
      // picked-count proxy. `voterId` (renamed from `playerId`) per the pin.
      you.factionVotes = killers.map((k) => {
        const vote = state.mafiaVotes.find((v) => v.playerId === k.id);
        return { voterId: k.id, targetId: vote?.targetId ?? null, locked: vote?.locked ?? false };
      });
      you.lockedCount = you.factionVotes.filter((v) => v.locked).length;
      // Redefined (Spec 08): true iff all relevant killers are locked AND
      // the ruleset's consensus rule is satisfied.
      you.consensusReached = resolveConsensus(state.mafiaVotes, killers, state.ruleset.mafiaConsensus, { lockedOnly: true }).converged;
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
      if (vote) {
        you.currentVote = vote.target;
        you.dayVoteLocked = vote.locked; // Spec 11: tentative vs confirmed.
      }
    }
    // Spec 11: the viewer's own dawn acknowledgement state — never a
    // denominator or per-seat list (the no-count-leak ban), only their own.
    if (viewerPlayer.alive && state.phase === "dawn") {
      you.acknowledged = state.acknowledgedBy.includes(viewerPlayer.id);
    }
    view.you = you;
  }
  return view;
}
