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

/** Room-wide visual skin selected by the non-playing host. This is deliberately
 * a closed, public enum: it is unrelated to the Storyteller's free-text
 * narration setting and never carries role or faction information. */
export type VisualTheme = "atelier" | "club" | "rain";

export const VISUAL_THEMES = ["atelier", "club", "rain"] as const satisfies readonly VisualTheme[];

export function isVisualTheme(value: unknown): value is VisualTheme {
  return typeof value === "string" && (VISUAL_THEMES as readonly string[]).includes(value);
}

export interface ClientRoomState {
  roomCode: string;
  phase: "lobby" | EnginePhase;
  players: ClientPlayerView[];
  hostConnected: boolean;
  createdAt: number;
  /** Public room skin and its monotonic server revision. Both are present on
   * every welcome/snapshot, including legacy rooms and in-game rejoin. */
  visualTheme: VisualTheme;
  visualThemeRevision: number;
  game: ClientGameView | null;
  /** Spec 06 D1 / Spec 11: the host's pending lobby ruleset, broadcast so
   * players see the roster (counts only, not assignments) before the game
   * starts. `null` until the host first sets one (server defaults it to the
   * house ruleset at claim time). Structurally the engine's `Ruleset`, but
   * typed loosely here (like `StartGameMessage.ruleset`) so `shared/` stays
   * free of an engine import — the engine re-validates it authoritatively. */
  pendingRuleset: PendingRuleset | null;
  /** Spec 15 (AI narrator). Populated by `buildStateFor` ONLY for a host
   * viewer — `null`/omitted for every player viewer (leak-tested). Carries
   * settings + persona bible + the KEPT scene history only; a pending
   * (not-yet-committed) draft never rides here (see `story_draft`). */
  story?: StoryState | null;
}

/** Spec 15. The five narrator tones offered in the Storyteller setup card. */
export type Tone = "noir" | "cozy" | "horror" | "comedy" | "absurd";

/** Spec 15. One beat family member — see the spec's Beats table for the
 * legal-phase pinning (`sunrise-hold`->`sunrise`, etc). */
export type BeatId = "sunrise-hold" | "sunset-hold" | "morning-report" | "post-vote" | "epilogue";

/** Spec 15. Host-only narrator memory — settings + persona bible + KEPT
 * scenes only (auto-keep latest; no Keep button). Cleared on rematch. */
export interface StoryState {
  enabled: boolean;
  settings: { theme: string; tone: Tone };
  bible: Record<string, string>;
  scenes: Array<{ beat: BeatId; day: number; text: string }>;
}

/** The subset of the engine `Ruleset` the lobby roster card reads. Kept
 * standalone (no engine import) — the server stores/validates the full
 * object; this only shapes what the client rendering needs. */
export interface PendingRuleset {
  roles: Record<string, number | "auto">;
  [key: string]: unknown;
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

/** Spec 11. Locks the sender's tentative day vote (the day resolves only once
 * every living player has confirmed). Rejects `no_pick_to_lock` if they have
 * no cast vote, `not_your_phase` outside day/runoff. */
export interface ConfirmVoteMessage {
  type: "confirm_vote";
}

/** Spec 11. Returns a confirmed day vote to tentative. */
export interface UnconfirmVoteMessage {
  type: "unconfirm_vote";
}

/** Spec 11. Acknowledges the current dawn Morning Report. `gen` echoes the
 * sender's latest `phaseGen` — a stale ack (gen mismatch) no-ops server-side,
 * so a queued ack can never acknowledge the next phase. */
export interface AcknowledgeMessage {
  type: "acknowledge";
  gen: number;
}

/** Spec 06 D1 / Spec 11. Host-only, lobby-only, debounced: sets the pending
 * lobby ruleset (role counts). Broadcast to players via
 * `ClientRoomState.pendingRuleset`. Excluded from `lastActivityAt` (idle
 * editing must not immortalize an empty room). `ruleset` is `unknown` on the
 * wire (like `start_game`) — the server validates it. */
export interface SetRulesetMessage {
  type: "set_ruleset";
  ruleset: unknown;
}

/** Spec 23 D1. Host-only, lobby-only: change the public room-wide visual
 * theme. The server validates the closed enum and increments the authoritative
 * revision before broadcasting a snapshot. */
export interface SetVisualThemeMessage {
  type: "set_visual_theme";
  visualTheme: VisualTheme;
}

/** Spec 08. Commits the sender's current tentative mafia-kill pick. Rejects
 * `no_pick_to_lock` if they have no target set, `not_lockable` if they're
 * not a living mafia-consensus killer during a night phase (including once
 * the night has already resolved — phase-gated before role-gated). */
export interface LockActionMessage {
  type: "lock_action";
}

/** Spec 08. Returns a previously locked mafia-kill pick to tentative.
 * Same rejections as `lock_action`. */
export interface UnlockActionMessage {
  type: "unlock_action";
}

/** Echoes the `phaseGen` from the sender's latest snapshot — the engine
 * no-ops (with a `stale_advance` rejection) if it doesn't match the current
 * generation, guarding against a double-fire from a stale client. */
export interface ForceAdvanceMessage {
  type: "force_advance";
  gen: number;
}

/** Spec 12. Host-only narrator reveal. Legal ONLY while the engine phase is
 * `sunrise`/`sunset` (else rejected `reveal_not_active`); echoes `phaseGen`
 * like `force_advance` and rejects loudly `stale_advance` on a mismatch (the
 * host UI disables the button — not the silent no-op `acknowledge` uses).
 * Resolves the deferred night/vote and advances to dawn/dusk. */
export interface RevealMessage {
  type: "reveal";
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

/** Spec 15. Host-only, any time (lobby or in-game): sets the Storyteller
 * enabled flag + theme/tone. Stored in DO storage; changeable mid-game.
 * Rejected for non-host like other host-only messages. */
export interface SetStorySettingsMessage {
  type: "set_story_settings";
  enabled: boolean;
  theme: string;
  tone: Tone;
}

/** Spec 15. Host-only: request a new scene draft for `beat`. `phaseGen`
 * mirrors `reveal`/`force_advance` — the server rejects a mismatch
 * (`stale_story`) or a beat whose legal phase != the current phase
 * (`wrong_phase`). `requestId` is client-minted and echoed verbatim on the
 * `story_draft`/`story_error` reply so the UI can correlate a tap to its
 * result even across a [Re-spin]. */
export interface GenerateStoryMessage {
  type: "generate_story";
  beat: BeatId;
  phaseGen: number;
  requestId: string;
}

/** Spec 15. Host-only: drops the pending draft for `requestId` without
 * committing it (auto-keep otherwise commits on beat supersession). */
export interface DiscardStoryMessage {
  type: "discard_story";
  requestId: string;
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
  | ConfirmVoteMessage
  | UnconfirmVoteMessage
  | AcknowledgeMessage
  | LockActionMessage
  | UnlockActionMessage
  | ForceAdvanceMessage
  | RevealMessage
  | MarkAbsentMessage
  | MarkPresentMessage
  | SetRulesetMessage
  | SetVisualThemeMessage
  | NewGameMessage
  | SetStorySettingsMessage
  | GenerateStoryMessage
  | DiscardStoryMessage;

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

/** Spec 15. Host-sockets-only (never sent to a player socket — leak-tested):
 * a fresh draft for `requestId`/`beat`/`phaseGen`. The host UI drops any
 * draft whose `phaseGen` no longer matches its current phaseGen (a slow
 * draft for a since-force-advanced beat renders nowhere). Not persisted —
 * ephemeral until auto-keep commits it into `ClientRoomState.story`. */
export interface StoryDraftMessage {
  type: "story_draft";
  requestId: string;
  beat: BeatId;
  phaseGen: number;
  text: string;
}

/** Spec 15. Host-sockets-only. `generation_failed` never touches game state
 * or phase machinery — it's purely "the muse is silent, try again." */
export interface StoryErrorMessage {
  type: "story_error";
  requestId: string;
  code: "disabled" | "busy" | "rate_limited" | "stale_story" | "wrong_phase" | "generation_failed";
}

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | KickedMessage
  | ErrorMessage
  | RejectionMessage
  | PongMessage
  | StoryDraftMessage
  | StoryErrorMessage;

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
  | "room_full"
  | "game_in_progress"
  | "invalid_name"
  | "not_host"
  | "not_lobby"
  | "player_not_found"
  | "invalid_ruleset";
