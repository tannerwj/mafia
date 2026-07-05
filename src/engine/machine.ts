import { nextRandom, shuffle } from "./rng";
import { materializeRoleCounts, type Ruleset } from "./ruleset";
import { activeNightActionFor, canSubmitMafiaVote, configureRoles, currentRoles, getRole, hasNightInput, mafiaKillers, type RoleRegistry } from "./roles";
import { resolveNight } from "./resolve-night";
import { resolveConsensus } from "./consensus";
import { evaluateWin } from "./win";
import type { Command, Effect, EngineResult, GameEvent, GameState, LobbyPlayer, PlayerState, VoteTarget } from "./types";

function clone(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function timerMs(state: GameState): number | null {
  const seconds = state.phase === "night" ? state.ruleset.timers.night : state.phase === "day" ? state.ruleset.timers.day ?? state.ruleset.timers.voting : state.phase === "runoff" ? state.ruleset.timers.runoff ?? state.ruleset.timers.voting : undefined;
  return seconds === undefined ? (state.phase === "dawn" || state.phase === "dusk" ? state.ruleset.dawnDuskBeatMs : null) : seconds * 1000;
}

function effectsForDeadline(state: GameState, now?: number): Effect[] {
  const ms = timerMs(state);
  if (ms === null || now === undefined || state.phase === "ended") return state.deadlineAt === null ? [] : [{ type: "clearDeadline" }];
  const at = now + ms;
  state.deadlineAt = at;
  return [{ type: "setDeadline", at }];
}

function transition(state: GameState, phase: GameState["phase"], now?: number): Effect[] {
  state.phase = phase;
  state.phaseGen += 1;
  state.deadlineAt = null;
  if (phase === "night") {
    state.day += 1;
    state.cycleDeaths = 0;
  }
  state.log.push({ type: "phaseChanged", phase, day: state.day, phaseGen: state.phaseGen });
  const effects = effectsForDeadline(state, now);
  if (phase === "ended") return [{ type: "clearDeadline" }];
  return effects;
}

function withWin(state: GameState, effects: Effect[], event?: GameEvent): EngineResult {
  const win = evaluateWin(state, currentRoles(), event);
  if (win) {
    state.phase = "ended";
    state.winners = win.winners;
    state.deadlineAt = null;
    state.phaseGen += 1;
    state.log.push({ type: "gameEnded", winners: win.winners, reason: win.reason });
    return { state, effects: [{ type: "clearDeadline" }, { type: "gameEnded", winners: win.winners }] };
  }
  return { state, effects };
}

export function startGame(players: LobbyPlayer[], ruleset: Ruleset, seed: number, now: number, roles?: RoleRegistry): EngineResult {
  configureRoles(roles);
  const counts = materializeRoleCounts(ruleset, players.length);
  const roleIds = Object.entries(counts).flatMap(([roleId, count]) => Array.from({ length: count }, () => roleId));
  const shuffled = shuffle(roleIds, seed);
  const assigned: PlayerState[] = players.map((player, seat) => ({
    id: player.id,
    seat,
    roleId: shuffled.items[seat] ?? "villager",
    alive: true,
    absent: false,
  }));
  const state: GameState = {
    phase: "night",
    day: 1,
    players: assigned,
    ruleset,
    rngState: shuffled.rngState,
    deadlineAt: null,
    phaseGen: 0,
    log: [{ type: "gameStarted", roleAssignments: assigned.map((p) => ({ playerId: p.id, roleId: p.roleId })) }],
    nightActions: [],
    mafiaVotes: [],
    votes: [],
    runoffCandidates: null,
    investigationResults: [],
    deaths: [],
    winners: null,
    cycleDeaths: 0,
  };
  const deadlineEffects = effectsForDeadline(state, now);
  return advanceIfComplete(state, deadlineEffects, now);
}

function reject(state: GameState, code: string, playerId?: string): EngineResult {
  return { state, effects: [], rejection: playerId === undefined ? { code } : { code, playerId } };
}

function alive(state: GameState, playerId: string): boolean {
  return state.players.some((p) => p.id === playerId && p.alive);
}

function legalLivingTarget(state: GameState, actorId: string, targetId: string | null, allowSelf: boolean): boolean {
  if (targetId === null) return true;
  if (!state.players.some((p) => p.id === targetId && p.alive)) return false;
  return allowSelf || targetId !== actorId;
}

export function applyCommand(input: GameState, cmd: Command): EngineResult {
  const state = clone(input);
  try {
    if (cmd.type === "timerExpired") {
      if (cmd.at !== state.deadlineAt) return { state: input, effects: [] };
      return advancePhase(state, cmd.now, true);
    }
    if (cmd.type === "forceAdvance") {
      if (!cmd.byHost) return reject(input, "not_host");
      if (cmd.gen !== state.phaseGen) return reject(input, "stale_advance");
      return advancePhase(state, cmd.now, true);
    }
    if (cmd.type === "markAbsent" || cmd.type === "markPresent") {
      if (!cmd.byHost) return reject(input, "not_host", cmd.playerId);
      const player = state.players.find((p) => p.id === cmd.playerId);
      if (!player) return reject(input, "unknown_player", cmd.playerId);
      player.absent = cmd.type === "markAbsent";
      state.log.push({ type: cmd.type === "markAbsent" ? "playerAbsent" : "playerPresent", playerId: cmd.playerId });
      return advanceIfComplete(state, [], cmd.now);
    }
    if (!alive(state, cmd.playerId)) return reject(input, "not_alive", cmd.playerId);
    const player = state.players.find((p) => p.id === cmd.playerId)!;
    if (player.absent) return reject(input, "absent", cmd.playerId);
    if (cmd.type === "submitAction") return submitAction(input, state, cmd);
    if (cmd.type === "castVote") return castVote(input, state, cmd.playerId, cmd.target, cmd.now);
    if (cmd.type === "retractVote") return retractVote(input, state, cmd.playerId);
    if (cmd.type === "lockAction") return setMafiaLock(input, state, cmd.playerId, true, cmd.now);
    if (cmd.type === "unlockAction") return setMafiaLock(input, state, cmd.playerId, false, cmd.now);
    return reject(input, "invalid_command");
  } catch {
    return reject(input, "invalid_command", "playerId" in cmd ? cmd.playerId : undefined);
  }
}

function submitAction(original: GameState, state: GameState, cmd: Extract<Command, { type: "submitAction" }>): EngineResult {
  if (state.phase !== "night") return reject(original, "not_your_phase", cmd.playerId);
  if (canSubmitMafiaVote(state, currentRoles(), cmd.playerId)) {
    if (!legalLivingTarget(state, cmd.playerId, cmd.targetId, false)) return reject(original, "illegal_target", cmd.playerId);
    state.mafiaVotes = state.mafiaVotes.filter((v) => v.playerId !== cmd.playerId);
    // Changing/(re)submitting a target always resets locked to false (Spec
    // 08): the voter is re-opening their choice, so partners see it's back
    // in play, and readiness must not carry over a lock onto a new target.
    state.mafiaVotes.push({ playerId: cmd.playerId, targetId: cmd.targetId, locked: false });
    state.log.push({ type: "actionSubmitted", actorId: cmd.playerId, actionType: "mafiaKill", targetId: cmd.targetId, day: state.day });
    return advanceIfComplete(state, [], cmd.now);
  }
  const spec = activeNightActionFor(state, currentRoles(), cmd.playerId);
  if (!spec || spec.consensus === "mafia") return reject(original, "not_your_phase", cmd.playerId);
  const allowSelf = spec.targetRule === "living-any";
  if (!legalLivingTarget(state, cmd.playerId, cmd.targetId, allowSelf)) return reject(original, "illegal_target", cmd.playerId);
  state.nightActions = state.nightActions.filter((a) => a.actorId !== cmd.playerId);
  state.nightActions.push({ actorId: cmd.playerId, actionType: spec.actionType, targetId: cmd.targetId });
  state.log.push({ type: "actionSubmitted", actorId: cmd.playerId, actionType: spec.actionType, targetId: cmd.targetId, day: state.day });
  return advanceIfComplete(state, [], cmd.now);
}

/** `lock_action`/`unlock_action` (Spec 08). Phase-gate before role-gate (both
 * reject safely, per the spec): a lock/unlock arriving once the night has
 * already resolved (phase moved past "night") rejects as `not_lockable`,
 * never silently ignored. Applies only to a living voter whose role is a
 * mafia-consensus killer during night — anyone else (including a
 * currently-absent killer, which `alive()`/`player.absent` in
 * `applyCommand` already gate before we get here) also gets
 * `not_lockable`. Locking with no target set (`targetId === null`) is
 * `no_pick_to_lock`, distinct from `not_lockable`. */
function setMafiaLock(original: GameState, state: GameState, playerId: string, locked: boolean, now?: number): EngineResult {
  if (state.phase !== "night") return reject(original, "not_lockable", playerId);
  if (!canSubmitMafiaVote(state, currentRoles(), playerId)) return reject(original, "not_lockable", playerId);
  const vote = state.mafiaVotes.find((v) => v.playerId === playerId);
  if (locked && (!vote || vote.targetId === null)) return reject(original, "no_pick_to_lock", playerId);
  if (!vote) return reject(original, "not_lockable", playerId);
  vote.locked = locked;
  state.log.push({ type: locked ? "actionLocked" : "actionUnlocked", actorId: playerId, day: state.day });
  return advanceIfComplete(state, [], now);
}

function castVote(original: GameState, state: GameState, playerId: string, target: VoteTarget, now?: number): EngineResult {
  if (state.phase !== "day" && state.phase !== "runoff") return reject(original, "not_your_phase", playerId);
  if (target === "no_murder") {
    if (!state.ruleset.noMurderOption || state.phase === "runoff") return reject(original, "illegal_target", playerId);
  } else if (!state.players.some((p) => p.id === target && p.alive)) return reject(original, "illegal_target", playerId);
  if (state.phase === "runoff" && target !== "no_murder" && !state.runoffCandidates?.includes(target)) return reject(original, "illegal_target", playerId);
  state.votes = state.votes.filter((v) => v.playerId !== playerId);
  state.votes.push({ playerId, target });
  state.log.push({ type: "voteCast", voterId: playerId, target, day: state.day, phase: state.phase });
  return advanceIfComplete(state, [], now);
}

function retractVote(original: GameState, state: GameState, playerId: string): EngineResult {
  if (state.phase !== "day" && state.phase !== "runoff") return reject(original, "not_your_phase", playerId);
  state.votes = state.votes.filter((v) => v.playerId !== playerId);
  state.log.push({ type: "voteRetracted", voterId: playerId, day: state.day, phase: state.phase });
  return { state, effects: [] };
}

// Night mafia-kill readiness (Spec 08, the crux): the phase can only
// complete NATURALLY once every living non-absent killer is LOCKED
// (designated mode: only the designated killer's lock gates it — see
// resolveConsensus) AND the ruleset's consensus rule actually converges on
// a target. Tentative (unlocked) picks never make the phase ready — that's
// what stops a stray matching tap from ending the night early. Unanimous
// mode's "all locked but disagree" state is a real pin: `ready` alone is
// NOT enough to advance — the phase must stay open ("keep deciding") until
// either they reconcile or the host force-advances/times out (which reads
// LOCKED-only plurality via `resolveLockedPlurality`, bypassing this gate
// entirely). Majority/designated always converge once ready (a plurality/
// the designated pick always exists), so this only ever blocks unanimous.
function mafiaReady(state: GameState): boolean {
  const killers = mafiaKillers(state, currentRoles());
  const result = resolveConsensus(state.mafiaVotes, killers, state.ruleset.mafiaConsensus, { lockedOnly: true });
  return result.ready && (result.converged || killers.length === 0);
}

function pendingNight(state: GameState): number {
  const individual = state.players.filter((p) => hasNightInput(state, currentRoles(), p.id) && !state.nightActions.some((a) => a.actorId === p.id)).length;
  const killers = mafiaKillers(state, currentRoles());
  const mafiaPending = killers.length > 0 && !mafiaReady(state) ? 1 : 0;
  return individual + mafiaPending;
}

function pendingVotes(state: GameState): number {
  return state.players.filter((p) => p.alive && !p.absent && !state.votes.some((v) => v.playerId === p.id)).length;
}

function advanceIfComplete(state: GameState, effects: Effect[], now?: number): EngineResult {
  if (state.phase === "night" && pendingNight(state) === 0) return advancePhase(state, now, false);
  if ((state.phase === "day" || state.phase === "runoff") && pendingVotes(state) === 0) return advancePhase(state, now, false);
  return withWin(state, effects);
}

/** `forced`: true only for the host force-advance / alarm timerExpired
 * paths (Spec 08 amends Spec 02 v2.3) — night resolution then reads LOCKED
 * votes by plurality regardless of the ruleset's consensus mode or whether
 * it naturally converged, discarding tentative/unlocked picks entirely.
 * `false` (the natural zero-pending-input advance) resolves through the
 * ruleset's own consensus mode, which by construction only ever reaches
 * this branch once `mafiaReady` already held. */
function advancePhase(state: GameState, now?: number, forced = false): EngineResult {
  if (state.phase === "night") {
    const resolved = resolveNight(clone(state), currentRoles(), forced);
    return withWin(resolved, transition(resolved, "dawn", now));
  }
  if (state.phase === "dawn") return withWin(state, transition(state, "day", now));
  if (state.phase === "day" || state.phase === "runoff") return resolveVote(state, now);
  if (state.phase === "dusk") return withWin(state, transition(state, "night", now));
  return { state, effects: [] };
}

function resolveVote(state: GameState, now?: number): EngineResult {
  const tally = new Map<VoteTarget, number>();
  for (const vote of state.votes) tally.set(vote.target, (tally.get(vote.target) ?? 0) + 1);
  const living = state.players.filter((p) => p.alive);
  let eliminated: string | null = null;
  let reason = "peace";
  if (tally.size > 0) {
    const ordered = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const topCount = ordered[0]![1];
    const tied = ordered.filter(([, count]) => count === topCount).map(([target]) => target);
    if (state.ruleset.dayVoteThreshold === "majority" && topCount <= living.length / 2) {
      reason = "no_majority";
    } else if (tied.length === 1) {
      const only = tied[0]!;
      eliminated = only === "no_murder" ? null : only;
      reason = only === "no_murder" ? "no_murder" : "eliminated";
    } else {
      const playerTies = tied.filter((t): t is string => t !== "no_murder");
      if (state.phase === "runoff") reason = "runoff_tie";
      else if (tied.includes("no_murder")) reason = "tie_with_no_murder";
      else if (state.ruleset.tiePolicy === "runoff-then-peace" && playerTies.length >= 2) {
        state.runoffCandidates = playerTies.sort((a, b) => state.players.find((p) => p.id === a)!.seat - state.players.find((p) => p.id === b)!.seat);
        state.votes = [];
        state.log.push({ type: "runoffStarted", candidates: state.runoffCandidates, day: state.day });
        return withWin(state, transition(state, "runoff", now));
      } else if (state.ruleset.tiePolicy === "random") {
        const next = nextRandom(state.rngState);
        state.rngState = next.state;
        const pick: string | null = playerTies[Math.floor(next.value * playerTies.length)] ?? null;
        eliminated = pick;
        reason = "random";
      } else if (state.ruleset.tiePolicy === "kill-all") {
        for (const target of playerTies) killByVote(state, target);
        state.log.push({ type: "voteResolved", eliminatedId: null, day: state.day, reason: "kill_all" });
        state.votes = [];
        state.runoffCandidates = null;
        return withWin(state, transition(state, "dusk", now));
      } else if (state.ruleset.tiePolicy === "no-murder") {
        reason = "no_murder";
      } else reason = "tie_peace";
    }
  }
  if (eliminated) {
    const event = killByVote(state, eliminated);
    state.log.push({ type: "voteResolved", eliminatedId: eliminated, day: state.day, reason });
    state.votes = [];
    state.runoffCandidates = null;
    const win = withWin(state, [], event);
    if (win.state.phase === "ended") return win;
  } else {
    state.log.push({ type: "voteResolved", eliminatedId: null, day: state.day, reason });
    state.votes = [];
    state.runoffCandidates = null;
  }
  return withWin(state, transition(state, "dusk", now));
}

function killByVote(state: GameState, playerId: string): GameEvent {
  const player = state.players.find((p) => p.id === playerId)!;
  player.alive = false;
  const role = getRole(currentRoles(), player.roleId);
  state.deaths.push({ playerId, roleId: player.roleId, alignment: role.alignment, day: state.day, phase: state.phase, cause: "vote" });
  state.cycleDeaths += 1;
  const event: GameEvent = { type: "playerDied", playerId, roleId: player.roleId, cause: "vote", day: state.day };
  state.log.push(event);
  return event;
}
