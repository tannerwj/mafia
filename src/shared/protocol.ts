// Shared client <-> server message protocol.
//
// Single source of truth for every WebSocket message shape. Both
// `src/client` and `src/server` import from here — never duplicate these
// types. Change only via a spec (see docs/specs/01-protocol-identity-rooms.md).

// ---------------------------------------------------------------------------
// Room state (lobby scope — Spec 01). Later specs extend `phase` beyond
// 'lobby' and add role/private-knowledge fields; this file is the contract
// each spec grows.
// ---------------------------------------------------------------------------

export interface ClientPlayerView {
  id: string;
  name: string;
  connected: boolean;
  isYou: boolean;
}

export interface ClientRoomState {
  roomCode: string;
  phase: "lobby";
  players: ClientPlayerView[];
  hostConnected: boolean;
  createdAt: number;
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

export type ClientMessage =
  | HelloMessage
  | KickMessage
  | LeaveMessage
  | PingMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Reply to a successful `hello`. `seatToken` is present only when a seat was
 * just minted (brand-new join) — it is never resent on rejoin, and never
 * broadcast to anyone but its owner. */
export interface WelcomeMessage {
  type: "welcome";
  you: {
    playerId?: string;
    seatToken?: string;
    isHost: boolean;
  };
  state: ClientRoomState;
}

/** Full personalized snapshot. Sent after every state-changing event to every
 * connected socket (each gets its own projection). No deltas. */
export interface SnapshotMessage {
  type: "snapshot";
  state: ClientRoomState;
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
  | "player_not_found";
