import type { ClientGameView, GraveyardEntry, RoleCount, Viewer } from "../shared/game-view";
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

// Spec 12 Feature 3: alive-role counts as {roleId, count} AGGREGATES ONLY.
// Grouped and counted — NEVER a per-living-player array (even name-stripped: a
// positional list would map join-order position → identity). Exposed to EVERY
// viewer at all phases (Tanner's transparency choice — full counts always,
// regardless of `revealOnDeath`). Sorted by roleId for a stable order that
// carries no seat/identity signal. Note the deliberately-accepted tradeoff
// (spec §Feature 3): under a hidden/no-reveal setup this reveals the exact
// alive-role breakdown, and a death's timing can retroactively correlate to a
// count change — both accepted, same tradeoff as showing counts at all.
function rolesRemaining(state: GameState): RoleCount[] {
  const counts = new Map<string, number>();
  for (const p of state.players) {
    if (!p.alive) continue;
    counts.set(p.roleId, (counts.get(p.roleId) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([roleId, count]) => ({ roleId, count }));
}

// Spec 12 Feature 3: the graveyard — one entry per dead player, role shown per
// `revealOnDeath` (reusing the same disclosure rule as `revealForPublic`).
// Ordered by death (deaths array order). Exposed to every viewer.
function graveyard(state: GameState): GraveyardEntry[] {
  const full = state.phase === "ended" || state.ruleset.revealOnDeath === "full";
  const alignmentOnly = state.ruleset.revealOnDeath === "alignment";
  return state.deaths.map((d) => {
    const entry: GraveyardEntry = { playerId: d.playerId, day: d.day, cause: d.cause };
    if (full) {
      entry.roleId = d.roleId;
      entry.alignment = d.alignment;
    } else if (alignmentOnly) {
      entry.alignment = d.alignment;
    }
    return entry;
  });
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
    // Spec 12 Feature 3: aggregate-only game status for every viewer.
    rolesRemaining: rolesRemaining(state),
    graveyard: graveyard(state),
    headcount: { alive: state.players.filter((p) => p.alive).length, total: state.players.length },
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

// ---------------------------------------------------------------------------
// Spec 12 Feature 1 — narrator board history (HOST-ONLY derived helper).
//
// `state.votes`/`mafiaVotes`/`nightActions` are CLEARED every phase, so the
// per-day/per-night board history cannot read them — it is RECONSTRUCTED by
// replaying the host projection's log. We key off the `*Locked` events
// (`actionLocked`/`voteLocked`), so "locked only" falls out for free: a row
// exists iff that actor locked. The target is recovered by pairing each lock
// with that actor's most-recent PRECEDING `actionSubmitted`/`voteCast` for the
// same day (the engine invariant that re-submitting clears the lock guarantees
// the locked pick is the last-submitted one). Last-locked-wins within a day
// (unlock→relock, or a lock after a re-pick, overwrites the earlier row).
//
// This is host-ONLY by contract: it reads `actionSubmitted` targets, which the
// projection strips from every non-host log (`resolvedLog`), so a non-host
// caller literally cannot reconstruct night targets from their own projection.
// It takes the raw event log (the host's `game.log`) — NOT a new projection
// variant, NOT retained raw state. Do NOT wire this onto any player path.
// ---------------------------------------------------------------------------

export interface NarratorBoardDay {
  day: number;
  /** Locked night actions this night, keyed last-locked-wins by actor. */
  nightActions: { actorId: string; actionType: string; targetId: string | null }[];
  /** Locked day votes this day, keyed last-locked-wins by voter. Runoff and
   * initial day votes share a `day` number, so the latest lock (runoff)
   * naturally supersedes — matching "current locked picture for that day". */
  dayVotes: { voterId: string; target: string | null }[];
}

export function narratorBoardHistory(log: GameEvent[]): NarratorBoardDay[] {
  // Per day, track the most-recent submitted target per actor as we scan, and
  // snapshot it into the row when that actor locks.
  const days = new Map<number, {
    nightSubs: Map<string, { actionType: string; targetId: string | null }>;
    nightLocked: Map<string, { actionType: string; targetId: string | null }>;
    voteSubs: Map<string, string | null>;
    voteLocked: Map<string, string | null>;
  }>();
  const dayFor = (d: number) => {
    let entry = days.get(d);
    if (!entry) {
      entry = { nightSubs: new Map(), nightLocked: new Map(), voteSubs: new Map(), voteLocked: new Map() };
      days.set(d, entry);
    }
    return entry;
  };

  for (const e of log) {
    if (e.type === "actionSubmitted") {
      dayFor(e.day).nightSubs.set(e.actorId, { actionType: e.actionType, targetId: e.targetId });
    } else if (e.type === "actionUnlocked") {
      dayFor(e.day).nightLocked.delete(e.actorId);
    } else if (e.type === "actionLocked") {
      const d = dayFor(e.day);
      const sub = d.nightSubs.get(e.actorId);
      // A lock always follows a submit for the currently-held target (engine
      // invariant); fall back to a null target defensively if not seen.
      d.nightLocked.set(e.actorId, sub ?? { actionType: "watch", targetId: null });
    } else if (e.type === "voteCast") {
      dayFor(e.day).voteSubs.set(e.voterId, e.target);
    } else if (e.type === "voteRetracted" || e.type === "voteUnlocked") {
      if (e.type === "voteUnlocked") dayFor(e.day).voteLocked.delete(e.voterId);
      else dayFor(e.day).voteSubs.delete(e.voterId);
    } else if (e.type === "voteLocked") {
      const d = dayFor(e.day);
      d.voteLocked.set(e.voterId, d.voteSubs.get(e.voterId) ?? null);
    }
  }

  return [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, d]) => ({
      day,
      nightActions: [...d.nightLocked.entries()].map(([actorId, v]) => ({ actorId, actionType: v.actionType, targetId: v.targetId })),
      dayVotes: [...d.voteLocked.entries()].map(([voterId, target]) => ({ voterId, target })),
    }));
}
