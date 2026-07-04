// Shared client <-> server message protocol.
//
// Single source of truth for every WebSocket message shape. Both
// `src/client` and `src/server` import from here — never duplicate these
// types. Change only via a spec (see docs/specs/01-protocol-identity-rooms.md).

import type { ClientGameView, Phase as EnginePhase } from "./game-view";

// ---------------------------------------------------------------------------
// Room state (lobby scope — Spec 01; extended by Spec 03 to compose a game).
// `phase` is `"lobby"` until a game starts, after which it mirrors the
// engine's own phase — Spec 01's lobby gate reads this composed value.
// `game` is the engine's projected view for this connection's identity, or
// `null` while in the lobby. `ClientGameView` never carries its own players
// array — identity/`connected`/`isYou` live only on `ClientRoomState.players`
// for the room's whole life; the client joins the two by `id`. Player order
// is join order, always, in both arrays — never reordered by alive/role
// status (reordering leaks information).
// ---------------------------------------------------------------------------

export interface ClientPlayerView {
  id: string;
  name: string;
  connected: boolean;
  isYou: boolean;
}

export interface ClientRoomState {
  roomCode: string;
  phase: "lobby" | EnginePhase;
  players: ClientPlayerView[];
  hostConnected: boolean;
  createdAt: number;
  game: ClientGameView | null;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** Sent once, immediately after the WebSocket opens. */
export interface HelloMessage {
  type: "hello";
  auth:
    | { kind: "host"; hostKey: string }
    | { kind: "seat"; seatToken: string }
    | { kind: "join"; name: string };
}

/** Host-only, lobby-only: remove a player and close their sockets. */
export interface KickMessage {
  type: "kick";
  playerId: string;
}

/** Voluntary, lobby-only: frees the sender's own name and seat. */
export interface LeaveMessage {
  type: "leave";
}

/** Heartbeat — see client connection layer for cadence. */
export interface PingMessage {
  type: "ping";
}

// ---------------------------------------------------------------------------
// Game commands (Spec 03). Host-only commands are asserted server-side
// against the socket's attachment kind, never the payload.
// ---------------------------------------------------------------------------

/** Host-only, lobby-only. `seed` is honored only when the Worker env has
 * `ALLOW_TEST_SEED="1"` (tests / local dev) — silently ignored otherwise, so
 * production always seeds from `crypto.getRandomValues`. */
export interface StartGameMessage {
  type: "start_game";
  ruleset: unknown;
  seed?: number;
}

export interface SubmitActionMessage {
  type: "submit_action";
  action: { actionType?: string; targetId: string | null };
}

export interface CastVoteMessage {
  type: "cast_vote";
  target: string;
}

export interface RetractVoteMessage {
  type: "retract_vote";
}

/** Echoes the `phaseGen` from the sender's latest snapshot — the engine
 * no-ops (with a `stale_advance` rejection) if it doesn't match the current
 * generation, guarding against a double-fire from a stale client. */
export interface ForceAdvanceMessage {
  type: "force_advance";
  gen: number;
}

export interface MarkAbsentMessage {
  type: "mark_absent";
  playerId: string;
}

export interface MarkPresentMessage {
  type: "mark_present";
  playerId: string;
}

/** Host-only. Only accepted once the engine phase is `ended` — deletes the
 * `game` key, keeps all seats/tokens, returns the room to lobby. */
export interface NewGameMessage {
  type: "new_game";
}

export type ClientMessage =
  | HelloMessage
  | KickMessage
  | LeaveMessage
  | PingMessage
  | StartGameMessage
  | SubmitActionMessage
  | CastVoteMessage
  | RetractVoteMessage
  | ForceAdvanceMessage
  | MarkAbsentMessage
  | MarkPresentMessage
  | NewGameMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Reply to a successful `hello`. `seatToken` is present only when a seat was
 * just minted (brand-new join) — it is never resent on rejoin, and never
 * broadcast to anyone but its owner. `serverNow` is epoch ms at send time —
 * clients compute a clock offset once per connection and render countdowns
 * against corrected time (skewed phone clocks are common). */
export interface WelcomeMessage {
  type: "welcome";
  you: {
    playerId?: string;
    seatToken?: string;
    isHost: boolean;
  };
  state: ClientRoomState;
  serverNow: number;
}

/** Full personalized snapshot. Sent after every state-changing event to every
 * connected socket (each gets its own projection). No deltas. */
export interface SnapshotMessage {
  type: "snapshot";
  state: ClientRoomState;
  serverNow: number;
}

/** A normal game answer to a rejected command (e.g. `not_your_phase`) —
 * distinct from `error`: never closes the socket, no reconnect behavior
 * attaches to it. Sent only to the socket that issued the rejected command. */
export interface RejectionMessage {
  type: "rejection";
  code: string;
}

/** Sent to a kicked player immediately before the server closes their
 * socket(s) with close code 4001. */
export interface KickedMessage {
  type: "kicked";
}

/** `code` is machine-readable (snake_case) and is the only thing client logic
 * keys on; `message` is for humans/logs. */
export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export interface PongMessage {
  type: "pong";
}

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | KickedMessage
  | ErrorMessage
  | RejectionMessage
  | PongMessage;

export type ProtocolMessage = ClientMessage | ServerMessage;

// ---------------------------------------------------------------------------
// WebSocket close codes (pinned semantics — see spec's close-code table).
// ---------------------------------------------------------------------------

export const CLOSE_KICKED = 4001;
/** Auth timeout — a pending socket sent no (or an unrecognized) `hello` in
 * time. Retryable timing failure, NOT a credential verdict. */
export const CLOSE_AUTH_TIMEOUT = 4002;
/** Bad credential (`bad_host_key` / `bad_seat_token`). Terminal for that
 * credential — the client discards it and falls back to the join UI. */
export const CLOSE_BAD_CREDENTIAL = 4003;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "unknown_type"
  | "bad_message"
  | "not_authenticated"
  | "bad_host_key"
  | "bad_seat_token"
  | "name_taken"
  | "game_in_progress"
  | "invalid_name"
  | "not_host"
  | "not_lobby"
  | "player_not_found"
  | "invalid_ruleset";
