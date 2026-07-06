// Host-only derived view (D3). A pure function of `ClientRoomState`, never a
// separate store slot — the spec's pin is "host-only data kept OFF any
// player-rendered path by construction: separate slice, not a flag on shared
// objects." This module IS that separation: it lives under `store/`, is
// imported only by `screens/host/**`, and it never mutates or reads back
// from anything a player screen touches. It composes exactly what
// `projectFor({kind:'host'})` already hands the connection (host-live god
// view: every role, full log, full votes) with the room's own
// identity/presence array (`ClientRoomState.players` — name/connected/isYou,
// present for every viewer, not host-exclusive) to build one row per seat.
import type { ClientGameView, Phase, PlayerId, RoleId } from "../../shared/game-view";
import type { ClientPlayerView, ClientRoomState } from "../../shared/protocol";

export interface HostSeatRow {
  id: PlayerId;
  name: string;
  connected: boolean;
  alive: boolean;
  absent: boolean;
  roleId?: RoleId;
  alignment?: string;
  /** This-phase status, derived only from fields the host projection
   * actually carries: `votes`/`voted`/`runoffCandidates` for day/runoff/
   * dusk, `players[].acted` (Spec 02 v2.7) for night. */
  status: SeatStatus;
}

export type SeatStatus =
  | { kind: "voted"; target: string | null }
  | { kind: "not-voted" }
  | { kind: "acted" }
  | { kind: "pending" }
  | { kind: "asleep" }
  | { kind: "no-vote-phase" }
  | { kind: "unknown" };

function alignmentTint(alignment: string | undefined): "blood" | "bone" | "brass" | "smoke" {
  if (alignment === "mafia") return "blood";
  if (alignment === "town") return "bone";
  if (alignment === "neutral") return "brass";
  return "smoke";
}

export { alignmentTint };

function seatStatus(game: ClientGameView, playerId: PlayerId, alive: boolean, absent: boolean): SeatStatus {
  if (!alive || absent) return { kind: "no-vote-phase" };
  if (game.phase === "night") {
    // `players[].acted` (Spec 02 v2.7) is host-only and night-only, and is
    // `undefined` (never `false`) for a seat with no owed action this phase
    // (villager/minion/bomber-style roles) — that maps to "asleep", never a
    // fabricated "pending" for a role with nothing to submit.
    const acted = game.players.find((p) => p.id === playerId)?.acted;
    if (acted === true) return { kind: "acted" };
    if (acted === false) return { kind: "pending" };
    return { kind: "asleep" };
  }
  const votingPhase = game.phase === "day" || game.phase === "runoff";
  if (!votingPhase) return { kind: "no-vote-phase" };
  if (game.votes) {
    const vote = game.votes.find((v) => v.playerId === playerId);
    return vote ? { kind: "voted", target: vote.target } : { kind: "not-voted" };
  }
  if (game.voted) {
    return game.voted.includes(playerId) ? { kind: "voted", target: null } : { kind: "not-voted" };
  }
  return { kind: "unknown" };
}

/** One row per seat, join order preserved (never reordered — D1 pin). */
export function hostSeatRows(room: ClientRoomState): HostSeatRow[] {
  const game = room.game;
  const gamePlayers = new Map(game?.players.map((p) => [p.id, p]) ?? []);
  return room.players.map((p: ClientPlayerView) => {
    const gp = gamePlayers.get(p.id);
    const row: HostSeatRow = {
      id: p.id,
      name: p.name,
      connected: p.connected,
      alive: gp?.alive ?? true,
      absent: gp?.absent ?? false,
      status: game ? seatStatus(game, p.id, gp?.alive ?? true, gp?.absent ?? false) : { kind: "no-vote-phase" },
    };
    if (gp?.roleId !== undefined) row.roleId = gp.roleId;
    if (gp?.alignment !== undefined) row.alignment = gp.alignment;
    return row;
  });
}

/** Phase-appropriate summary line under the phase header (D1 pin, e.g. "2 of
 * 3 mafia have voted", "waiting on 4 votes") — derived only from the host
 * projection, never invented. */
export function phaseSummary(game: ClientGameView, rows: HostSeatRow[]): string {
  const livingActive = rows.filter((r) => r.alive && !r.absent);
  if (game.phase === "night") {
    const actors = livingActive.filter((r) => r.status.kind === "acted" || r.status.kind === "pending");
    if (actors.length === 0) return "No one has an action tonight.";
    const acted = actors.filter((r) => r.status.kind === "acted").length;
    const pending = actors.length - acted;
    return pending > 0
      ? `${acted} of ${actors.length} have acted — waiting on ${pending}.`
      : `${acted} of ${actors.length} have acted.`;
  }
  if (game.phase === "day" || game.phase === "runoff") {
    const votedCount = rows.filter((r) => r.status.kind === "voted").length;
    const pending = livingActive.length - votedCount;
    return pending > 0
      ? `${votedCount} of ${livingActive.length} have voted — waiting on ${pending}.`
      : `${votedCount} of ${livingActive.length} have voted.`;
  }
  if (game.phase === "sunrise") return "Night is locked — narrate the scene, then tap Reveal.";
  if (game.phase === "sunset") return "The vote is locked — narrate the scene, then tap Reveal.";
  if (game.phase === "dawn") return "Resolving the night — dawn beat in progress.";
  if (game.phase === "dusk") return "Resolving the vote — dusk beat in progress.";
  return "";
}

export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "night":
      return "Night";
    case "sunrise":
      return "Sunrise";
    case "dawn":
      return "Dawn";
    case "day":
      return "Day";
    case "runoff":
      return "Runoff";
    case "sunset":
      return "Sunset";
    case "dusk":
      return "Dusk";
    case "ended":
      return "Game over";
  }
}

/** Per-phase force-advance confirm copy (D2 pin — exact wording matters:
 * night force-advance does NOT mean the kill fizzles). */
export function forceAdvanceCopy(phase: Phase): string {
  switch (phase) {
    case "night":
      return "Players who haven't acted will be treated as no-action. The mafia kill resolves by plurality of votes cast — it does not fizzle.";
    case "day":
    case "runoff":
      return "Players who haven't voted will abstain. The vote resolves with whoever has voted so far.";
    case "sunrise":
      return "This skips the narrator's reveal — the night resolves immediately and play continues to dawn.";
    case "sunset":
      return "This skips the narrator's reveal — the vote resolves immediately and play continues to dusk.";
    case "dawn":
    case "dusk":
      return "This skips the reveal beat — nothing is pending to resolve.";
    case "ended":
      return "";
  }
}
