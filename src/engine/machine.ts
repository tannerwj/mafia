import { nextRandom, shuffle } from "./rng";
import { materializeRoleCounts, type Ruleset } from "./ruleset";
import { activeNightActionFor, canSubmitMafiaVote, configureRoles, currentRoles, getRole, hasNightInput, mafiaKillers, type RoleRegistry } from "./roles";
import { resolveNight } from "./resolve-night";
import { lockReadiness, resolveConsensus } from "./consensus";
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
  // Spec 11: a fresh dawn starts with no acknowledgements — reset on every
  // transition so a queued ack for a past dawn can never carry forward (the
  // phaseGen guard on `acknowledge` is the primary defense; this is belt-and-
  // suspenders and keeps the field bounded).
  state.acknowledgedBy = [];
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
    acknowledgedBy: [],
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
    if (cmd.type === "reveal") {
      if (!cmd.byHost) return reject(input, "not_host");
      // Legal ONLY in a scene-holding phase — a reveal anywhere else is a
      // loud rejection (the host UI only shows the button in sunrise/sunset),
      // NOT the silent no-op acknowledge uses for its many uncoordinated
      // callers. Phase-gate BEFORE the gen guard so a reveal fired outside a
      // scene phase always reads `reveal_not_active`, never `stale_advance`.
      if (state.phase !== "sunrise" && state.phase !== "sunset") return reject(input, "reveal_not_active");
      if (cmd.gen !== state.phaseGen) return reject(input, "stale_advance");
      return revealScene(state, cmd.now);
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
    if (cmd.type === "confirmVote") return setVoteLock(input, state, cmd.playerId, true, cmd.now);
    if (cmd.type === "unconfirmVote") return setVoteLock(input, state, cmd.playerId, false, cmd.now);
    if (cmd.type === "lockAction") return setNightLock(input, state, cmd.playerId, true, cmd.now);
    if (cmd.type === "unlockAction") return setNightLock(input, state, cmd.playerId, false, cmd.now);
    if (cmd.type === "acknowledge") return acknowledge(input, state, cmd.playerId, cmd.gen, cmd.now);
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
  // Spec 11: individual actions are pick→confirm — (re)submitting a target
  // always resets `locked` to false (same rule as mafia votes), so a stray
  // matching tap never carries a lock onto a new target and readiness waits
  // for an explicit confirm.
  state.nightActions.push({ actorId: cmd.playerId, actionType: spec.actionType, targetId: cmd.targetId, locked: false });
  state.log.push({ type: "actionSubmitted", actorId: cmd.playerId, actionType: spec.actionType, targetId: cmd.targetId, day: state.day });
  return advanceIfComplete(state, [], cmd.now);
}

/** `lock_action`/`unlock_action` (Spec 08, generalized in Spec 11). Phase-gate
 * before role-gate (both reject safely): a lock/unlock arriving once the night
 * has already resolved (phase moved past "night") rejects as `not_lockable`,
 * never silently ignored. Dispatches on the sender's night input:
 *   - a living mafia-consensus killer → locks their mafia kill vote;
 *   - any other living non-absent player → locks their INDIVIDUAL night
 *     submission (a real action OR the decoy `"watch"`), the Spec 11 uniform
 *     pick→confirm flow.
 * Locking with no pick set (`targetId === null` / no submission) is
 * `no_pick_to_lock`, distinct from `not_lockable`. */
function setNightLock(original: GameState, state: GameState, playerId: string, locked: boolean, now?: number): EngineResult {
  if (state.phase !== "night") return reject(original, "not_lockable", playerId);
  const registry = currentRoles();
  if (canSubmitMafiaVote(state, registry, playerId)) {
    const vote = state.mafiaVotes.find((v) => v.playerId === playerId);
    if (locked && (!vote || vote.targetId === null)) return reject(original, "no_pick_to_lock", playerId);
    if (!vote) return reject(original, "not_lockable", playerId);
    vote.locked = locked;
    state.log.push({ type: locked ? "actionLocked" : "actionUnlocked", actorId: playerId, day: state.day });
    return advanceIfComplete(state, [], now);
  }
  // Individual night input (real or decoy). `hasNightInput` gates who may
  // lock at all — a player with no owed night input (e.g. a dead/absent seat,
  // already rejected upstream) is `not_lockable`.
  if (!hasNightInput(state, registry, playerId)) return reject(original, "not_lockable", playerId);
  const action = state.nightActions.find((a) => a.actorId === playerId);
  if (locked && (!action || action.targetId === null)) return reject(original, "no_pick_to_lock", playerId);
  if (!action) return reject(original, "not_lockable", playerId);
  action.locked = locked;
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
  // Spec 11: a cast vote is TENTATIVE (`locked:false`) — re-casting a
  // different target always returns it to tentative (same rule as night
  // picks), so the day phase never resolves early on an all-tentative table.
  state.votes.push({ playerId, target, locked: false });
  state.log.push({ type: "voteCast", voterId: playerId, target, day: state.day, phase: state.phase });
  return advanceIfComplete(state, [], now);
}

function retractVote(original: GameState, state: GameState, playerId: string): EngineResult {
  if (state.phase !== "day" && state.phase !== "runoff") return reject(original, "not_your_phase", playerId);
  state.votes = state.votes.filter((v) => v.playerId !== playerId);
  state.log.push({ type: "voteRetracted", voterId: playerId, day: state.day, phase: state.phase });
  return { state, effects: [] };
}

/** Spec 11: `confirm_vote`/`unconfirm_vote` lock/unlock the sender's tentative
 * DAY vote. Phase-gated to day/runoff; confirming with no cast vote is
 * `no_pick_to_lock`. Locking is what makes the day phase ready (all living
 * locked); unlocking or re-casting returns to tentative. */
function setVoteLock(original: GameState, state: GameState, playerId: string, locked: boolean, now?: number): EngineResult {
  if (state.phase !== "day" && state.phase !== "runoff") return reject(original, "not_your_phase", playerId);
  const vote = state.votes.find((v) => v.playerId === playerId);
  if (locked && !vote) return reject(original, "no_pick_to_lock", playerId);
  if (!vote) return reject(original, "not_lockable", playerId);
  vote.locked = locked;
  state.log.push({ type: locked ? "voteLocked" : "voteUnlocked", voterId: playerId, day: state.day, phase: state.phase });
  return advanceIfComplete(state, [], now);
}

/** Spec 11: `acknowledge` the current dawn Morning Report. phaseGen-guarded
 * like `forceAdvance` — a queued ack whose `gen` no longer matches the current
 * phase is a stale no-op (must not ack the next phase). Only meaningful during
 * dawn; outside dawn it's a harmless no-op (no error surface — a late ack for
 * a dawn that already advanced is expected). Once every living player has
 * acknowledged, the dawn advances to day. */
function acknowledge(original: GameState, state: GameState, playerId: string, gen: number, now?: number): EngineResult {
  if (gen !== state.phaseGen) return { state: original, effects: [] };
  if (state.phase !== "dawn") return { state: original, effects: [] };
  if (state.acknowledgedBy.includes(playerId)) return { state: original, effects: [] };
  state.acknowledgedBy.push(playerId);
  state.log.push({ type: "acknowledged", playerId, day: state.day });
  return advanceIfComplete(state, [], now);
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

// Spec 11: night readiness = every living non-absent INDIVIDUAL night input
// (real action OR decoy `"watch"`) is LOCKED, AND mafia consensus is met.
// `hasNightInput` now includes decoy roles, so `individualParticipants` is
// every living non-absent player who is NOT a mafia-consensus killer. Uses the
// shared `lockReadiness` helper (do not fork). A tentative (unlocked) pick
// never makes the night ready — same gate as the day vote.
function pendingNight(state: GameState): number {
  const registry = currentRoles();
  const individualParticipants = state.players.filter((p) => hasNightInput(state, registry, p.id)).map((p) => p.id);
  const submissions = state.nightActions.map((a) => ({ id: a.actorId, locked: a.locked }));
  const individualPending = individualParticipants.length - lockReadiness(individualParticipants, submissions).lockedCount;
  const killers = mafiaKillers(state, registry);
  const mafiaPending = killers.length > 0 && !mafiaReady(state) ? 1 : 0;
  return individualPending + mafiaPending;
}

// Spec 11 REDEFINITION (⚠ the crux): count living non-absent players WITHOUT a
// LOCKED vote (not merely without a cast). The phase resolves only when
// `pendingVotes === 0` — i.e. every living player has confirmed. Counting
// "uncast" here would resolve the day early on an all-tentative table (the
// opposite bug). Uses the shared `lockReadiness` helper.
function pendingVotes(state: GameState): number {
  const participants = state.players.filter((p) => p.alive && !p.absent).map((p) => p.id);
  const submissions = state.votes.map((v) => ({ id: v.playerId, locked: v.locked }));
  return participants.length - lockReadiness(participants, submissions).lockedCount;
}

// Spec 11: dawn is acknowledge-gated. It advances once every living non-absent
// player has acknowledged the Morning Report. The beat backstop
// (timerExpired) and host force-advance still advance it regardless (both take
// the `forced` path in advancePhase — dawn→day is unconditional there).
function pendingDawnAcks(state: GameState): number {
  return state.players.filter((p) => p.alive && !p.absent && !state.acknowledgedBy.includes(p.id)).length;
}

function advanceIfComplete(state: GameState, effects: Effect[], now?: number): EngineResult {
  if (state.phase === "night" && pendingNight(state) === 0) return advancePhase(state, now, false);
  if (state.phase === "dawn" && pendingDawnAcks(state) === 0) return advancePhase(state, now, false);
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
    // Spec 12: DEFER RESOLUTION. When scenePhases is on, a NATURAL night-
    // readiness advance transitions to `sunrise` WITHOUT running resolveNight —
    // the night stays UNRESOLVED (nothing computed, nothing can leak) until the
    // host taps `reveal`. A FORCED advance (host force-advance / timer) is the
    // host's explicit escape hatch and resolves directly to dawn, bypassing the
    // narration beat (host-only, so no leak concern). sunrise is only ever
    // reached via the natural all-locked+converged gate, so reveal's non-forced
    // resolveNight reproduces the same kill.
    if (state.ruleset.scenePhases && !forced) return { state, effects: transition(state, "sunrise", now) };
    const resolved = resolveNight(clone(state), currentRoles(), forced);
    return withWin(resolved, transition(resolved, "dawn", now));
  }
  if (state.phase === "sunrise") {
    // A forced advance out of sunrise (host force-advance / timer) resolves the
    // deferred night. `reveal` routes here via revealScene too.
    const resolved = resolveNight(clone(state), currentRoles(), forced);
    return withWin(resolved, transition(resolved, "dawn", now));
  }
  if (state.phase === "dawn") return withWin(state, transition(state, "day", now));
  if (state.phase === "day" || state.phase === "runoff") {
    // Spec 12: symmetric deferral for the day vote — natural readiness → sunset
    // (vote UNRESOLVED); forced resolves directly to dusk.
    if (state.ruleset.scenePhases && !forced) return { state, effects: transition(state, "sunset", now) };
    return resolveVote(state, now);
  }
  if (state.phase === "sunset") return resolveVote(state, now);
  if (state.phase === "dusk") return withWin(state, transition(state, "night", now));
  return { state, effects: [] };
}

/** Spec 12: the host-tapped `reveal`. Resolves the deferred night/vote held in
 * sunrise/sunset — non-forced (sunrise/sunset are only ever reached via the
 * natural readiness gate, which already required consensus convergence / all
 * votes locked, so a non-forced resolution reproduces exactly the outcome the
 * narrator saw from the locked inputs). */
function revealScene(state: GameState, now?: number): EngineResult {
  if (state.phase === "sunrise") {
    const resolved = resolveNight(clone(state), currentRoles(), false);
    return withWin(resolved, transition(resolved, "dawn", now));
  }
  // sunset
  return resolveVote(state, now);
}

function resolveVote(state: GameState, now?: number): EngineResult {
  // Spec 11: resolve from LOCKED votes only. On a natural resolution every
  // living player is locked (readiness gate). On a forced/timer resolution,
  // unlocked (tentative) votes are treated as abstentions — the pinned
  // "resolve from locked votes only" rule.
  const tally = new Map<VoteTarget, number>();
  for (const vote of state.votes) {
    if (!vote.locked) continue;
    tally.set(vote.target, (tally.get(vote.target) ?? 0) + 1);
  }
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
        playerTies.sort((a, b) => {
          const aSeat = state.players.find((player) => player.id === a)?.seat ?? 9999;
          const bSeat = state.players.find((player) => player.id === b)?.seat ?? 9999;
          return aSeat - bSeat || a.localeCompare(b);
        });
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
