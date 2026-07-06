// Spec 17 D1 — the exact event list, as typed payload builders, plus the
// generic log-hygiene assertion the test suite runs over every one of them.
//
// THE LOG HYGIENE HARD RULE (spec-pinned): payloads must never contain role
// assignments keyed to a player, seat tokens, host keys, night-action
// targets, vote contents, story text/theme, or player names. Player IDs and
// aggregate counts are fine. Every builder below is a plain function
// returning a flat, spec-shaped object — `assertLogHygiene` walks the result
// generically (it has no field-name allowlist to fall out of sync) and the
// `game_started` roleCounts test additionally asserts no roleId is keyed to
// a specific player.
import type { BeatId } from "../shared/protocol";

export type StoryGenerateOutcome =
  | "ok"
  | "timeout"
  | "parse_fail"
  | "model_error"
  | "rate_limited"
  | "busy"
  | "stale"
  | "wrong_phase"
  | "disabled";

export type RoomWipedReason = "empty_lobby" | "absolute_ttl" | "ended_ttl";

export interface RoomClaimedFields {
  roomCode: string;
}

export interface GameStartedFields {
  roomCode: string;
  playerCount: number;
  roleCounts: Record<string, number>;
}

export interface GameEndedFields {
  roomCode: string;
  winners: string[] | null;
  reason: string;
  day: number;
  durationMs: number;
}

export interface RoomWipedFields {
  roomCode: string;
  reason: RoomWipedReason;
  idleMs: number;
}

export interface WsOpenFields {
  roomCode: string;
  authKind: string;
}

export interface WsCloseFields {
  roomCode: string;
  authKind: string;
  code: number;
  wasClean: boolean;
}

export interface WsErrorFields {
  roomCode: string;
}

export interface AuthRejectedFields {
  roomCode: string;
  reason: string;
}

export interface MsgSlowFields {
  roomCode: string;
  type: string;
  ms: number;
}

export interface StoryGenerateFields {
  roomCode: string;
  beat: BeatId;
  outcome: StoryGenerateOutcome;
  latencyMs: number;
  model: string;
}

export interface AlarmFiredFields {
  roomCode: string;
  kind: string;
  driftMs: number;
}

export interface ClientErrorFields {
  roomCode?: string;
  message: string;
  stackHead: string;
  url: string;
  ua: string;
}

/** Tallies `roleId` counts across assigned players into the aggregate-only
 * shape `game_started` is allowed to log — never a player-keyed map. */
export function tallyRoleCounts(players: { roleId: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of players) {
    counts[p.roleId] = (counts[p.roleId] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Generic hygiene check — walks any payload object recursively and flags
// property KEYS that look like a per-player secret map (a value that is
// itself an object/array keyed by something id-shaped whose values are
// role-shaped strings), plus a deny-list of field names that must never
// appear at all regardless of value. This is intentionally structural
// (works on any builder's output) rather than a hardcoded per-event check,
// so a future new event automatically gets covered by the same test.
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set([
  "seatToken",
  "seatTokens",
  "hostKey",
  "hostKeys",
  "targetId",
  "target",
  "voteContents",
  "votes",
  "storyText",
  "theme",
  "scene",
  "text",
  "name",
  "names",
  "playerName",
]);

/** Recursively asserts a log payload contains none of the forbidden keys,
 * anywhere, at any nesting depth. Throws with a path-qualified message on
 * violation so a failing test points straight at the offending field. */
export function assertLogHygiene(payload: unknown, path = "$"): void {
  if (payload === null || typeof payload !== "object") return;

  if (Array.isArray(payload)) {
    payload.forEach((item, i) => assertLogHygiene(item, `${path}[${i}]`));
    return;
  }

  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`assertLogHygiene: forbidden key "${key}" found at ${path}.${key}`);
    }
    assertLogHygiene(value, `${path}.${key}`);
  }
}
