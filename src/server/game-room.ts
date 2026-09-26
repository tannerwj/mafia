import { DurableObject } from "cloudflare:workers";
import type {
  BeatId,
  ClientMessage,
  ClientPlayerView,
  ClientRoomState,
  ErrorCode,
  ServerMessage,
  StoryState,
  VisualTheme,
} from "../shared/protocol";
import {
  CLOSE_AUTH_TIMEOUT,
  CLOSE_BAD_CREDENTIAL,
  CLOSE_KICKED,
  isVisualTheme,
} from "../shared/protocol";
import {
  applyCommand,
  HOUSE_ROLE_DEFS,
  HOUSE_RULES,
  projectFor,
  startGame,
  validateRuleset,
  type Command,
  type Effect,
  type GameEvent,
  type GameState,
  type LobbyPlayer,
  type Ruleset,
} from "../engine";
import {
  BEAT_PHASE,
  buildPrompt,
  buildStoryFacts,
  fakeStoryOutput,
  parseStoryOutput,
  type StoryMemory,
  type StorySettings,
} from "./storyteller";
import { logEvent } from "./log";
import { tallyRoleCounts, type StoryGenerateOutcome } from "./log-events";
import { writeMetric } from "./metrics";

// ---------------------------------------------------------------------------
// Storage schema (Spec 01). No in-memory session state anywhere — everything
// that must survive hibernation/eviction lives in `ctx.storage`, and identity
// lives only in the WebSocket attachment (never trusted from client input).
// ---------------------------------------------------------------------------

interface RoomMeta {
  code: string;
  hostKey: string;
  // Spec 01 only ever writes "lobby" — the type is a plain string (rather
  // than the literal) so tests can fake a later phase via direct storage
  // write, per the D6 "join-while-not-lobby" test.
  phase: string;
  createdAt: number;
  lastActivityAt: number;
  /** Spec 23 D1. Optional on the interface because rooms claimed before the
   * theme field existed may still be in storage; read through
   * `readVisualTheme` before exposing or mutating these values. */
  visualTheme?: VisualTheme;
  visualThemeRevision?: number;
}

interface PlayerRecord {
  id: string;
  name: string;
  seatToken: string;
  joinedAt: number;
}

interface PendingAuthEntry {
  tagId: string;
  connectedAt: number;
}

/** Identity authority for a socket — set once at accept time (`pending`),
 * replaced on successful `hello`. Read via `ws.deserializeAttachment()`,
 * never inferred from client-supplied ids. Attachments hold identity only,
 * never game state (16KiB serializeAttachment limit). */
type Attachment =
  | { kind: "pending"; tagId: string; connectedAt: number }
  | { kind: "host"; connectedAt: number }
  | { kind: "player"; playerId: string; connectedAt: number };

const ROOM_KEY = "room";
const DEFAULT_VISUAL_THEME: VisualTheme = "atelier";
const PLAYERS_KEY = "players";
const PENDING_AUTH_KEY = "pendingAuth";
const GAME_KEY = "game";
const GAME_DEADLINE_KEY = "gameDeadlineAt";
// Spec 17: when the current game (if any) started — the only durable
// timestamp that predates a `gameEnded` effect and postdates lobby wait
// time, so `game_ended`'s `durationMs` measures actual play, not
// time-since-room-claim. Written in `handleStartGame`, cleared on rematch.
const GAME_STARTED_AT_KEY = "gameStartedAt";
// Spec 06 D1 / Spec 11: the host's pending lobby ruleset (role counts).
// Defaulted to HOUSE_RULES at claim time; overwritten by `set_ruleset`.
const PENDING_RULESET_KEY = "pendingRuleset";
// Spec 15: per-game narrator memory (settings + persona bible + KEPT scenes
// only). Eager-init at claim time to a disabled default, mirroring
// PENDING_RULESET_KEY — no lazy-init ambiguity (§Memory).
const STORY_STATE_KEY = "storyState";
// Spec 15 (M6/v2-re-review Finding 7 fix): the queue-of-one in-flight
// generation record. MUST live in ctx.storage, never DO memory — a DO can be
// evicted mid-`env.AI.run()` await and an in-memory flag would hang the room
// "busy" forever (the same async-coordination pattern as GAME_DEADLINE_KEY).
// The draft TEXT itself stays memory-only (ephemeral by design); only this
// coordination flag needs durability.
const STORY_INFLIGHT_KEY = "storyInflight";

interface StoryInflightRecord {
  requestId: string;
  beat: BeatId;
  phaseGen: number;
  startedAt: number;
}

const STORY_INFLIGHT_STALE_MS = 20_000; // past the 15s AI timeout
const STORY_RATE_LIMIT_PER_MIN = 10;
const STORY_AI_TIMEOUT_MS = 15_000;
const STORY_MAX_BYTES = 32 * 1024; // ~32KB cap (§Memory) via scene trimming
// Spec 17 D4: promoted from a hardcoded string literal at each call site (was
// duplicated in isStoryRateLimited/recordStoryGeneration) to a named constant
// next to the other STORY_* keys, and now deleted on rematch alongside the
// rest of per-game story bookkeeping.
const STORY_RATE_LIMIT_KEY = "storyRateLimit";

const DEFAULT_STORY_STATE: StoryState = {
  enabled: false,
  settings: { theme: "", tone: "noir" },
  bible: {},
  scenes: [],
};

const AUTH_REAP_MS = 30_000;
const EMPTY_LOBBY_TTL_MS = 60 * 60 * 1000; // 1h
// Spec 17 D4: a room whose game has ENDED (with no live sockets) wipes 2h
// after lastActivityAt — between the 1h empty-lobby path (which only ever
// applies in the lobby) and the 6h absolute backstop (which still applies to
// every other phase, including a stuck/abandoned lobby with seated players).
const ENDED_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const ABSOLUTE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

/** Normalize the one piece of legacy room metadata that predates Spec 23.
 * This is the only fallback path: snapshots always carry a valid theme and a
 * nonnegative integer revision, and a malformed stored value cannot leak into
 * the client protocol. */
function readVisualTheme(room: RoomMeta): {
  visualTheme: VisualTheme;
  visualThemeRevision: number;
} {
  const storedRevision = room.visualThemeRevision;
  if (
    !isVisualTheme(room.visualTheme) ||
    typeof storedRevision !== "number" ||
    !Number.isSafeInteger(storedRevision) ||
    storedRevision < 0
  ) {
    return { visualTheme: DEFAULT_VISUAL_THEME, visualThemeRevision: 0 };
  }
  return { visualTheme: room.visualTheme, visualThemeRevision: storedRevision };
}

function normalizeCloseCode(code: number): number {
  return code >= 1000 && code < 5000 && !RESERVED_CLOSE_CODES.has(code)
    ? code
    : 1000;
}

/** `getWebSockets()` can still return a socket that was `close()`d earlier in
 * the same synchronous turn (e.g. a socket the alarm just reaped, or one a
 * kick just closed) — its readyState is no longer OPEN, but it hasn't been
 * dropped from the hibernation manager's bookkeeping yet. Every liveness,
 * presence, and broadcast check in this file must filter through this so a
 * just-closed socket never counts as "connected". */
function liveSockets(ctx: DurableObjectState, tag?: string): WebSocket[] {
  return ctx
    .getWebSockets(tag)
    .filter((sock) => sock.readyState === WebSocket.READY_STATE_OPEN);
}

/** Cloudflare tags are fixed at `acceptWebSocket` time and cannot be changed
 * on successful `hello` (only the attachment can). So tags stay `pending:<id>`
 * for their entire life and are never used to look up host/player sockets —
 * `socketsFor()` below does that by scanning all live sockets and reading
 * each one's attachment, which is the only identity authority. */
function socketsFor(
  ctx: DurableObjectState,
  predicate: (a: Attachment) => boolean,
): WebSocket[] {
  return liveSockets(ctx).filter((sock) => {
    const attachment = sock.deserializeAttachment() as Attachment | null;
    return attachment !== null && predicate(attachment);
  });
}

/** A not-yet-committed story draft. Deliberately in-memory ONLY (never
 * `ctx.storage`) — spec §Memory: "pending drafts are ephemeral by design."
 * If the DO is evicted mid-beat the draft is simply lost and the host
 * re-spins; only the queue-of-one coordination flag (STORY_INFLIGHT_KEY)
 * needs to survive eviction, not the draft text itself. */
interface PendingDraft {
  requestId: string;
  beat: BeatId;
  phaseGen: number;
  day: number;
  text: string;
  bibleUpdates: Record<string, string>;
}

/** Folds a kept draft into `storyState`: appends the scene, merges
 * `bibleUpdates` into the persona bible, and trims oldest scenes toward the
 * ~32KB cap (§Memory: "capped via summary folding" — v1 trims rather than
 * model-summarizing, a simpler, equally-safe-for-leaks approximation: no
 * summary text is ever generated, so there's nothing new to leak-test). */
function commitDraft(story: StoryState, draft: PendingDraft): StoryState {
  const scenes = [...story.scenes, { beat: draft.beat, day: draft.day, text: draft.text }];
  const bible = { ...story.bible, ...draft.bibleUpdates };
  let trimmed = scenes;
  while (trimmed.length > 1 && JSON.stringify({ ...story, scenes: trimmed, bible }).length > STORY_MAX_BYTES) {
    trimmed = trimmed.slice(1);
  }
  return { ...story, bible, scenes: trimmed };
}

export class GameRoom extends DurableObject<Env> {
  /** Draft-in-progress-or-awaiting-supersession state, keyed by requestId.
   * See `PendingDraft` — deliberately DO-memory only, never `ctx.storage`. */
  private pendingDrafts = new Map<string, PendingDraft>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Wake-recovery guard (flagged by Spec 03 v2.2 for hardening here):
    // persisting a deadline input (pendingAuth entry, lastActivityAt, a
    // future spec's gameDeadlineAt) and arming the alarm happen in separate
    // turns, so a crash between them can leave a due deadline with no armed
    // alarm. If we come back up with nothing armed, re-derive it from
    // storage — scheduleNextAlarm() is idempotent and no-ops safely when
    // there's no room or no deadline inputs.
    ctx.blockConcurrencyWhile(async () => {
      const alarm = await ctx.storage.getAlarm();
      if (alarm === null) {
        await this.scheduleNextAlarm();
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal claim endpoint — called only by the Worker's POST /api/rooms
    // handler, never reachable from a client directly (see Worker routing).
    if (url.pathname === "/internal/claim" && request.method === "POST") {
      return this.handleClaim(request);
    }

    if (url.pathname === "/internal/meta" && request.method === "GET") {
      return this.handleMeta();
    }

    if (url.pathname === "/internal/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
      if (!room) {
        return new Response("Room not found", { status: 404 });
      }

      const { 0: client, 1: server } = new WebSocketPair();
      const tagId = crypto.randomUUID();
      const connectedAt = Date.now();

      this.ctx.acceptWebSocket(server, [`pending:${tagId}`]);
      const attachment: Attachment = { kind: "pending", tagId, connectedAt };
      server.serializeAttachment(attachment);

      const pending =
        (await this.ctx.storage.get<PendingAuthEntry[]>(PENDING_AUTH_KEY)) ??
        [];
      pending.push({ tagId, connectedAt });
      await this.ctx.storage.put(PENDING_AUTH_KEY, pending);
      // scheduleNextAlarm() is idempotent and always run here regardless of
      // getAlarm()'s current value — this IS the belt-and-braces re-arm
      // (Spec 17 D4): it closes the theoretical orphan where a claim
      // succeeded but alarm scheduling failed and the DO has stayed live
      // ever since (so the constructor guard never got a chance to re-run).
      // One extra storage read/write per socket open — acceptable.
      await this.scheduleNextAlarm();

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleClaim(request: Request): Promise<Response> {
    const existing = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (existing) {
      return Response.json({ status: "taken" });
    }

    const body = (await request.json()) as { code: string };
    const now = Date.now();
    const hostKey = crypto.randomUUID();
    const room: RoomMeta = {
      code: body.code,
      hostKey,
      phase: "lobby",
      createdAt: now,
      lastActivityAt: now,
      visualTheme: DEFAULT_VISUAL_THEME,
      visualThemeRevision: 0,
    };
    await this.ctx.storage.put(ROOM_KEY, room);
    await this.ctx.storage.put(PLAYERS_KEY, [] as PlayerRecord[]);
    await this.ctx.storage.put(PENDING_RULESET_KEY, HOUSE_RULES);
    await this.ctx.storage.put(STORY_STATE_KEY, DEFAULT_STORY_STATE);
    await this.scheduleNextAlarm();
    logEvent("room_claimed", { roomCode: room.code });
    return Response.json({ status: "claimed", hostKey });
  }

  private async handleMeta(): Promise<Response> {
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room) {
      return Response.json({ exists: false });
    }
    return Response.json({ exists: true, phase: room.phase });
  }

  // -------------------------------------------------------------------------
  // WebSocket message handling
  // -------------------------------------------------------------------------

  // Spec 17 D1/D2 timing wrapper: every message gets a cheap `msg_timing`
  // metric point, and a `msg_slow` log line when handling exceeds 50ms. The
  // actual dispatch logic is unchanged below in `handleMessage` — this is
  // purely an outer timing shell so the 50ms/always-metric pins live in
  // exactly one place regardless of which message type came in.
  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const type = this.peekMessageType(message);
    const start = Date.now();
    try {
      await this.handleMessage(ws, message);
    } finally {
      const ms = Date.now() - start;
      const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
      const roomCode = room?.code ?? "unknown";
      // blobs[0] is always the metric NAME (a discriminator so RUNBOOK.md
      // queries can `WHERE blob1 = '...'` — every writeMetric call site in
      // this file follows the same convention) with the event-specific
      // blobs, if any, following it.
      writeMetric(this.env, { doubles: [ms], blobs: ["msg_timing", type], indexes: [roomCode] });
      if (ms > 50) {
        logEvent("msg_slow", { roomCode, type, ms });
      }
    }
  }

  /** Best-effort peek at `{type}` for timing/metrics ONLY — never used for
   * dispatch (that re-parses inside `handleMessage`, which is the sole
   * source of truth for message validity). Returns "unknown" for anything
   * that doesn't parse; never throws. */
  private peekMessageType(message: string | ArrayBuffer): string {
    if (typeof message !== "string") return "binary";
    try {
      const parsed = JSON.parse(message) as { type?: unknown };
      return typeof parsed?.type === "string" ? parsed.type : "unknown";
    } catch {
      return "unknown";
    }
  }

  private async handleMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      this.sendError(ws, "bad_message", "Binary frames are not supported.");
      return;
    }

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      this.sendError(ws, "bad_message", "Malformed JSON.");
      return;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      this.sendError(ws, "bad_message", "Malformed message.");
      return;
    }

    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) {
      // Should be unreachable — every accepted socket gets an attachment —
      // but treat as unauthenticated defensively rather than throw.
      this.sendError(ws, "not_authenticated", "No identity on socket.");
      ws.close(CLOSE_AUTH_TIMEOUT);
      return;
    }

    if (parsed.type !== "hello" && attachment.kind === "pending") {
      this.sendError(ws, "not_authenticated", "Send hello first.");
      ws.close(CLOSE_AUTH_TIMEOUT);
      return;
    }

    switch (parsed.type) {
      case "hello":
        await this.handleHello(ws, attachment, parsed);
        return;
      case "ping":
        this.send(ws, { type: "pong" });
        return;
      case "kick":
        await this.handleKick(ws, attachment, parsed.playerId);
        return;
      case "leave":
        await this.handleLeave(ws, attachment);
        return;
      case "start_game":
        await this.handleStartGame(ws, attachment, parsed);
        return;
      case "submit_action":
        await this.handleGameCommand(ws, attachment, (playerId) => ({
          type: "submitAction",
          playerId,
          targetId: parsed.action.targetId,
          now: Date.now(),
        }));
        return;
      case "cast_vote":
        await this.handleGameCommand(ws, attachment, (playerId) => ({
          type: "castVote",
          playerId,
          target: parsed.target,
          now: Date.now(),
        }));
        return;
      case "retract_vote":
        await this.handleGameCommand(ws, attachment, (playerId) => ({
          type: "retractVote",
          playerId,
          now: Date.now(),
        }));
        return;
      case "confirm_vote":
        await this.handleGameCommand(ws, attachment, (playerId) => ({
          type: "confirmVote",
          playerId,
          now: Date.now(),
        }));
        return;
      case "unconfirm_vote":
        await this.handleGameCommand(ws, attachment, (playerId) => ({
          type: "unconfirmVote",
          playerId,
          now: Date.now(),
        }));
        return;
      case "acknowledge":
        await this.handleGameCommand(ws, attachment, (playerId) => ({
          type: "acknowledge",
          playerId,
          gen: parsed.gen,
          now: Date.now(),
        }));
        return;
      case "set_ruleset":
        await this.handleSetRuleset(ws, attachment, parsed);
        return;
      case "set_visual_theme":
        await this.handleSetVisualTheme(ws, attachment, parsed);
        return;
      case "lock_action":
        await this.handleGameCommand(ws, attachment, (playerId) => ({
          type: "lockAction",
          playerId,
          now: Date.now(),
        }));
        return;
      case "unlock_action":
        await this.handleGameCommand(ws, attachment, (playerId) => ({
          type: "unlockAction",
          playerId,
          now: Date.now(),
        }));
        return;
      case "force_advance":
        await this.handleHostGameCommand(ws, attachment, {
          type: "forceAdvance",
          byHost: true,
          gen: parsed.gen,
          now: Date.now(),
        });
        return;
      case "reveal":
        await this.handleHostGameCommand(ws, attachment, {
          type: "reveal",
          byHost: true,
          gen: parsed.gen,
          now: Date.now(),
        });
        return;
      case "mark_absent":
        await this.handleHostGameCommand(ws, attachment, {
          type: "markAbsent",
          byHost: true,
          playerId: parsed.playerId,
          now: Date.now(),
        });
        return;
      case "mark_present":
        await this.handleHostGameCommand(ws, attachment, {
          type: "markPresent",
          byHost: true,
          playerId: parsed.playerId,
          now: Date.now(),
        });
        return;
      case "new_game":
        await this.handleNewGame(ws, attachment);
        return;
      case "set_story_settings":
        await this.handleSetStorySettings(ws, attachment, parsed);
        return;
      case "generate_story":
        await this.handleGenerateStory(ws, attachment, parsed);
        return;
      case "discard_story":
        await this.handleDiscardStory(ws, attachment, parsed);
        return;
      default:
        this.sendError(
          ws,
          "unknown_type",
          `Unknown message type: ${String((parsed as { type: unknown }).type)}`,
        );
        return;
    }
  }

  private async handleHello(
    ws: WebSocket,
    attachment: Attachment,
    msg: Extract<ClientMessage, { type: "hello" }>,
  ): Promise<void> {
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room) {
      this.sendError(ws, "bad_message", "Room does not exist.");
      ws.close(CLOSE_BAD_CREDENTIAL);
      return;
    }

    if (msg.auth.kind === "host") {
      if (msg.auth.hostKey !== room.hostKey) {
        logEvent("auth_rejected", { roomCode: room.code, reason: "bad_host_key" });
        this.sendError(ws, "bad_host_key", "Invalid host key.");
        ws.close(CLOSE_BAD_CREDENTIAL);
        return;
      }
      await this.completeAuth(ws, attachment, { kind: "host" });
      logEvent("ws_open", { roomCode: room.code, authKind: "host" });
      const state = await this.buildStateFor({ kind: "host" });
      this.send(ws, {
        type: "welcome",
        you: { isHost: true },
        state,
        serverNow: Date.now(),
      });
      await this.touchAndBroadcast({ excludeWs: ws });
      return;
    }

    if (msg.auth.kind === "seat") {
      const seatToken = msg.auth.seatToken;
      const players = await this.getPlayers();
      const player = players.find((p) => p.seatToken === seatToken);
      if (!player) {
        logEvent("auth_rejected", { roomCode: room.code, reason: "bad_seat_token" });
        this.sendError(ws, "bad_seat_token", "Unknown seat token.");
        ws.close(CLOSE_BAD_CREDENTIAL);
        return;
      }
      await this.completeAuth(ws, attachment, {
        kind: "player",
        playerId: player.id,
      });
      logEvent("ws_open", { roomCode: room.code, authKind: "seat" });
      const state = await this.buildStateFor({
        kind: "player",
        playerId: player.id,
      });
      this.send(ws, {
        type: "welcome",
        you: { playerId: player.id, isHost: false },
        state,
        serverNow: Date.now(),
      });
      await this.touchAndBroadcast({ excludeWs: ws });
      return;
    }

    // join: brand-new player, lobby-gated (rejoin-by-token above is not).
    if (room.phase !== "lobby") {
      this.sendError(ws, "game_in_progress", "Cannot join once the game has started.");
      return;
    }

    const name = msg.auth.name.trim();
    if (name.length < 1 || name.length > 20) {
      this.sendError(ws, "invalid_name", "Name must be 1-20 characters.");
      return;
    }

    const players = await this.getPlayers();
    const nameTaken = players.some(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (nameTaken) {
      this.sendError(ws, "name_taken", "That name is already taken.");
      return;
    }

    const playerId = crypto.randomUUID();
    const seatToken = crypto.randomUUID();
    const record: PlayerRecord = {
      id: playerId,
      name,
      seatToken,
      joinedAt: Date.now(),
    };
    players.push(record);
    await this.ctx.storage.put(PLAYERS_KEY, players);

    await this.completeAuth(ws, attachment, { kind: "player", playerId });
    logEvent("ws_open", { roomCode: room.code, authKind: "join" });
    const state = await this.buildStateFor({ kind: "player", playerId });
    this.send(ws, {
      type: "welcome",
      you: { playerId, seatToken, isHost: false },
      state,
      serverNow: Date.now(),
    });
    await this.touchAndBroadcast({ excludeWs: ws });
  }

  /** Update attachment, remove from pendingAuth, retag is not possible
   * (Cloudflare tags are fixed at accept time) — the attachment is the
   * identity authority from here on. */
  private async completeAuth(
    ws: WebSocket,
    prev: Attachment,
    next: { kind: "host" } | { kind: "player"; playerId: string },
  ): Promise<void> {
    const connectedAt = prev.kind === "pending" ? prev.connectedAt : Date.now();
    const attachment: Attachment =
      next.kind === "host"
        ? { kind: "host", connectedAt }
        : { kind: "player", playerId: next.playerId, connectedAt };
    ws.serializeAttachment(attachment);

    if (prev.kind === "pending") {
      const pending =
        (await this.ctx.storage.get<PendingAuthEntry[]>(PENDING_AUTH_KEY)) ??
        [];
      const filtered = pending.filter((e) => e.tagId !== prev.tagId);
      await this.ctx.storage.put(PENDING_AUTH_KEY, filtered);
    }
  }

  private async handleKick(
    ws: WebSocket,
    attachment: Attachment,
    targetPlayerId: string,
  ): Promise<void> {
    if (attachment.kind !== "host") {
      this.sendError(ws, "not_host", "Only the host can kick.");
      return;
    }

    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room || room.phase !== "lobby") {
      this.sendError(ws, "not_lobby", "Kick is only available in the lobby.");
      return;
    }

    const players = await this.getPlayers();
    const idx = players.findIndex((p) => p.id === targetPlayerId);
    if (idx === -1) {
      this.sendError(ws, "player_not_found", "No such player.");
      return;
    }

    // Atomicity: storage mutation + socket closes happen synchronously in
    // this turn (no `await` between the storage write below and the close
    // loop) so no in-flight `hello` presenting the removed seat token can
    // interleave with the kick.
    players.splice(idx, 1);
    const writePlayers = this.ctx.storage.put(PLAYERS_KEY, players);

    const sockets = socketsFor(
      this.ctx,
      (a) => a.kind === "player" && a.playerId === targetPlayerId,
    );
    for (const sock of sockets) {
      this.send(sock, { type: "kicked" });
      sock.close(CLOSE_KICKED);
    }

    await writePlayers;
    await this.touchAndBroadcast();
  }

  private async handleLeave(
    ws: WebSocket,
    attachment: Attachment,
  ): Promise<void> {
    if (attachment.kind !== "player") {
      this.sendError(ws, "bad_message", "Only players can leave.");
      return;
    }

    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room || room.phase !== "lobby") {
      this.sendError(ws, "not_lobby", "Leave is only available in the lobby.");
      return;
    }

    const playerId = attachment.playerId;
    const players = await this.getPlayers();
    const idx = players.findIndex((p) => p.id === playerId);
    if (idx === -1) {
      return;
    }
    players.splice(idx, 1);
    await this.ctx.storage.put(PLAYERS_KEY, players);

    const sockets = socketsFor(
      this.ctx,
      (a) => a.kind === "player" && a.playerId === playerId,
    );
    for (const sock of sockets) {
      sock.close(1000);
    }

    await this.touchAndBroadcast();
  }

  // -------------------------------------------------------------------------
  // Game lifecycle & commands (Spec 03). The engine (`startGame`,
  // `applyCommand`, `projectFor`, `validateRuleset`) is the only game
  // interface — this DO never reads or writes `GameState` internals beyond
  // persisting it opaquely and projecting through `projectFor`.
  // -------------------------------------------------------------------------

  private async handleStartGame(
    ws: WebSocket,
    attachment: Attachment,
    msg: Extract<ClientMessage, { type: "start_game" }>,
  ): Promise<void> {
    // Authority and lifecycle-state failures for start_game are rejections
    // (Spec 03 D4's authority test list groups start_game with
    // force_advance/mark_absent) — invalid_ruleset below is the one
    // explicitly pinned `error` case (D1: "errors return
    // error{invalid_ruleset, detail} to the host, room stays in lobby").
    if (attachment.kind !== "host") {
      this.sendRejection(ws, "not_host");
      return;
    }

    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room || room.phase !== "lobby") {
      this.sendRejection(ws, "game_in_progress");
      return;
    }

    const players = await this.getPlayers();
    if (players.length < 3) {
      this.sendError(ws, "invalid_ruleset", "At least 3 players are required.");
      return;
    }

    const ruleset = msg.ruleset as Ruleset;
    const validation = validateRuleset(ruleset, players.length);
    if (validation.errors.length > 0) {
      this.sendError(
        ws,
        "invalid_ruleset",
        validation.errors.map((e) => e.message).join(" "),
      );
      return;
    }

    // The production room uses the house six. Keep the engine's validator
    // extensible for custom role packs, but reject positive unknown roles at
    // the server boundary before startGame can call getRole and throw.
    const unknownPositiveRoles = Object.entries(ruleset.roles)
      .filter(
        ([roleId, count]) =>
          !Object.prototype.hasOwnProperty.call(HOUSE_ROLE_DEFS, roleId) &&
          typeof count === "number" &&
          count > 0,
      )
      .map(([roleId]) => roleId);
    if (unknownPositiveRoles.length > 0) {
      this.sendError(ws, "invalid_ruleset", `Unknown role ${unknownPositiveRoles[0]}.`);
      return;
    }

    const seed =
      this.env.ALLOW_TEST_SEED === "1" && msg.seed !== undefined
        ? msg.seed
        : crypto.getRandomValues(new Uint32Array(1))[0]!;

    const lobbyPlayers: LobbyPlayer[] = players.map((p) => ({
      id: p.id,
      name: p.name,
    }));
    const result = startGame(lobbyPlayers, ruleset, seed, Date.now());
    const roleCounts = tallyRoleCounts(result.state.players);
    await this.ctx.storage.put(GAME_STARTED_AT_KEY, Date.now());
    logEvent("game_started", { roomCode: room.code, playerCount: players.length, roleCounts });
    writeMetric(this.env, { doubles: [players.length], blobs: ["game_started"], indexes: [room.code] });
    await this.applyGameResult(result, null, room);
  }

  /** Spec 06 D1 / Spec 11. Host-only, lobby-only: store the pending lobby
   * ruleset and broadcast it (players see the roster via
   * `ClientRoomState.pendingRuleset`). Deliberately does NOT touch
   * `lastActivityAt` (`skipActivity: true`) — idle role-count editing must
   * not keep an otherwise-empty room alive forever (Spec 06 pin). Rejected
   * (not errored) for non-host / non-lobby, consistent with other host
   * lifecycle commands. Invalid JSON shape is rejected `invalid_ruleset`;
   * the authoritative validation still happens at `start_game`. */
  private async handleSetRuleset(
    ws: WebSocket,
    attachment: Attachment,
    msg: Extract<ClientMessage, { type: "set_ruleset" }>,
  ): Promise<void> {
    if (attachment.kind !== "host") {
      this.sendRejection(ws, "not_host");
      return;
    }
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room || room.phase !== "lobby") {
      this.sendRejection(ws, "not_lobby");
      return;
    }
    const ruleset = msg.ruleset as Ruleset;
    if (
      typeof ruleset !== "object" ||
      ruleset === null ||
      typeof (ruleset as { roles?: unknown }).roles !== "object"
    ) {
      this.sendRejection(ws, "invalid_ruleset");
      return;
    }
    await this.ctx.storage.put(PENDING_RULESET_KEY, ruleset);
    await this.touchAndBroadcast({ skipActivity: true });
  }

  /** Spec 23 D1. Host-only, lobby-only: persist one public room theme and
   * broadcast its authoritative revision. The storage transaction gates the
   * read/modify/write, so two host tabs cannot commit the same revision. */
  private async handleSetVisualTheme(
    ws: WebSocket,
    attachment: Attachment,
    msg: Extract<ClientMessage, { type: "set_visual_theme" }>,
  ): Promise<void> {
    if (attachment.kind !== "host") {
      this.sendRejection(ws, "not_host");
      return;
    }

    const result = await this.ctx.storage.transaction(async (txn) => {
      const room = await txn.get<RoomMeta>(ROOM_KEY);
      if (!room || room.phase !== "lobby") {
        return { kind: "rejection" as const, code: "not_lobby" };
      }
      if (!isVisualTheme(msg.visualTheme)) {
        return { kind: "rejection" as const, code: "invalid_visual_theme" };
      }

      const current = readVisualTheme(room);
      if (current.visualTheme === msg.visualTheme) {
        return { kind: "unchanged" as const };
      }

      await txn.put(ROOM_KEY, {
        ...room,
        visualTheme: msg.visualTheme,
        visualThemeRevision: current.visualThemeRevision + 1,
        // Activity is part of the same transaction as the theme revision.
        // The broadcast below deliberately skips its legacy whole-meta write
        // so a second host tab cannot commit a newer theme and then have that
        // value overwritten by a stale activity update.
        lastActivityAt: Date.now(),
      } satisfies RoomMeta);
      return { kind: "changed" as const };
    });

    if (result.kind === "rejection") {
      this.sendRejection(ws, result.code);
      return;
    }
    if (result.kind === "changed") {
      // Theme changes count as room activity via the transaction above. The
      // broadcast must not write RoomMeta again after another host tab has
      // committed a newer revision.
      await this.touchAndBroadcast({ skipActivity: true });
    }
  }

  /** Player-issued in-game commands (`submitAction`/`castVote`/
   * `retractVote`). Host sockets have no `playerId` and cannot issue these. */
  private async handleGameCommand(
    ws: WebSocket,
    attachment: Attachment,
    build: (playerId: string) => Command,
  ): Promise<void> {
    if (attachment.kind !== "player") {
      this.sendRejection(ws, "not_a_player");
      return;
    }
    const game = await this.ctx.storage.get<GameState>(GAME_KEY);
    if (!game) {
      this.sendRejection(ws, "no_game");
      return;
    }
    const result = applyCommand(game, build(attachment.playerId));
    await this.applyGameResult(result, game, undefined, ws);
  }

  /** Host-issued in-game commands (`forceAdvance`/`markAbsent`/
   * `markPresent`). Authority comes from the socket attachment, never the
   * client payload — `byHost` on the command is always set by us, here. */
  private async handleHostGameCommand(
    ws: WebSocket,
    attachment: Attachment,
    cmd: Command,
  ): Promise<void> {
    if (attachment.kind !== "host") {
      this.sendRejection(ws, "not_host");
      return;
    }
    const game = await this.ctx.storage.get<GameState>(GAME_KEY);
    if (!game) {
      this.sendRejection(ws, "no_game");
      return;
    }
    const result = applyCommand(game, cmd);
    await this.applyGameResult(result, game, undefined, ws);
  }

  private async handleNewGame(
    ws: WebSocket,
    attachment: Attachment,
  ): Promise<void> {
    if (attachment.kind !== "host") {
      this.sendRejection(ws, "not_host");
      return;
    }
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room) {
      this.sendError(ws, "bad_message", "Room does not exist.");
      return;
    }
    const game = await this.ctx.storage.get<GameState>(GAME_KEY);
    if (!game || game.phase !== "ended") {
      this.sendRejection(ws, "not_ended");
      return;
    }

    await this.ctx.storage.delete(GAME_KEY);
    await this.ctx.storage.delete(GAME_DEADLINE_KEY);
    // Spec 17 D4 (spec-pinned): storyRateLimit resets on rematch — a fresh
    // game is a fresh 10/min narrator budget, not a continuation of the
    // previous game's usage.
    await this.ctx.storage.delete(STORY_RATE_LIMIT_KEY);
    // GAME_STARTED_AT_KEY is purely a durationMs input for the next
    // game_ended — deleted so a rematch doesn't inherit the previous game's
    // start time and inflate the reported duration.
    await this.ctx.storage.delete(GAME_STARTED_AT_KEY);
    // Spec 15: narrator memory (bible + kept scenes) is per-game — cleared on
    // rematch. Settings (enabled/theme/tone) are a host preference, not game
    // state, so they're preserved across the reset. Auto-keep: a rematch is
    // the terminal supersession event for a still-pending epilogue draft
    // (game end already fired; there's no further phase advance to catch
    // it) — commit it first, fire-safe, before the memory wipe below would
    // otherwise discard it unread.
    try {
      let story = await this.getStoryState();
      for (const draft of this.pendingDrafts.values()) story = commitDraft(story, draft);
      await this.ctx.storage.put(STORY_STATE_KEY, {
        ...DEFAULT_STORY_STATE,
        enabled: story.enabled,
        settings: story.settings,
      } satisfies StoryState);
    } catch {
      // Fire-safe — a rematch must never fail because of story memory.
    } finally {
      this.pendingDrafts.clear();
    }
    await this.ctx.storage.delete(STORY_INFLIGHT_KEY);
    room.phase = "lobby";
    await this.ctx.storage.put(ROOM_KEY, room);
    await this.touchAndBroadcast();
  }

  // -------------------------------------------------------------------------
  // Spec 15 — AI narrator ("The Storyteller"). Host-only. See
  // docs/specs/15-ai-narrator.md THE LEAK CONTRACT: all model input flows
  // through `buildStoryFacts(view, beat)` in storyteller.ts, where `view` is
  // EXACTLY `projectFor(state, { kind: "public" })` — never raw `GameState`.
  // Draft TEXT is memory-only (never `ctx.storage`) until auto-commit; the
  // queue-of-one in-flight coordination record is the one piece that DOES
  // need `ctx.storage` durability (see STORY_INFLIGHT_KEY above).
  // -------------------------------------------------------------------------

  private async getStoryState(): Promise<StoryState> {
    return (await this.ctx.storage.get<StoryState>(STORY_STATE_KEY)) ?? DEFAULT_STORY_STATE;
  }

  private async handleSetStorySettings(
    ws: WebSocket,
    attachment: Attachment,
    msg: Extract<ClientMessage, { type: "set_story_settings" }>,
  ): Promise<void> {
    if (attachment.kind !== "host") {
      this.sendRejection(ws, "not_host");
      return;
    }
    const story = await this.getStoryState();
    const next: StoryState = {
      ...story,
      enabled: msg.enabled,
      settings: { theme: msg.theme, tone: msg.tone },
    };
    await this.ctx.storage.put(STORY_STATE_KEY, next);
    await this.touchAndBroadcast({ skipActivity: true });
  }

  /** Host-only: request a fresh draft for `beat`. Rejects (via `story_error`,
   * NOT a `rejection` — these are host-tool errors, not game commands)
   * disabled/busy/rate_limited/stale_story/wrong_phase before ever touching
   * `env.AI`. No `blockConcurrencyWhile` around the AI await (m9) — other
   * webSocketMessage turns interleave freely during the up-to-15s window.
   * Failure on ANY path here never touches game state or phase machinery. */
  private async handleGenerateStory(
    ws: WebSocket,
    attachment: Attachment,
    msg: Extract<ClientMessage, { type: "generate_story" }>,
  ): Promise<void> {
    // Spec 17 D1: every generate_story attempt — success or any rejection —
    // logs `story_generate`, so a host reporting "the narrator stopped
    // working" is finally diagnosable. `roomCode` is read once up front
    // since every early-rejection branch below needs it.
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    const roomCode = room?.code ?? "unknown";
    const attemptStart = Date.now();
    const logGenerate = (outcome: StoryGenerateOutcome) => {
      logEvent("story_generate", { roomCode, beat: msg.beat, outcome, latencyMs: Date.now() - attemptStart, model: this.env.STORYTELLER_MODEL });
      writeMetric(this.env, { doubles: [Date.now() - attemptStart], blobs: ["story_generate", outcome, this.env.STORYTELLER_MODEL], indexes: [roomCode] });
    };

    if (attachment.kind !== "host") {
      this.sendRejection(ws, "not_host");
      return;
    }

    const story = await this.getStoryState();
    if (!story.enabled) {
      logGenerate("disabled");
      this.sendStoryError(ws, msg.requestId, "disabled");
      return;
    }

    const game = await this.ctx.storage.get<GameState>(GAME_KEY);
    const currentPhase = game?.phase;
    const currentGen = game?.phaseGen;
    if (currentPhase !== BEAT_PHASE[msg.beat]) {
      logGenerate("wrong_phase");
      this.sendStoryError(ws, msg.requestId, "wrong_phase");
      return;
    }
    if (currentGen !== msg.phaseGen) {
      logGenerate("stale");
      this.sendStoryError(ws, msg.requestId, "stale_story");
      return;
    }

    // Queue-of-one: an in-flight record younger than the stale bound blocks a
    // second concurrent generation for this room.
    const inflight = await this.ctx.storage.get<StoryInflightRecord>(STORY_INFLIGHT_KEY);
    if (inflight && Date.now() - inflight.startedAt < STORY_INFLIGHT_STALE_MS) {
      logGenerate("busy");
      this.sendStoryError(ws, msg.requestId, "busy");
      return;
    }

    const rateLimited = await this.isStoryRateLimited();
    if (rateLimited) {
      logGenerate("rate_limited");
      this.sendStoryError(ws, msg.requestId, "rate_limited");
      return;
    }

    // Re-spin (a fresh generate_story for the SAME beat as an existing
    // pending draft): the replaced draft is DROPPED, never committed
    // (§Product shape Keep semantics) — only ever one pending draft per beat.
    for (const [id, draft] of this.pendingDrafts) {
      if (draft.beat === msg.beat) this.pendingDrafts.delete(id);
    }

    const record: StoryInflightRecord = {
      requestId: msg.requestId,
      beat: msg.beat,
      phaseGen: msg.phaseGen,
      startedAt: Date.now(),
    };
    await this.ctx.storage.put(STORY_INFLIGHT_KEY, record);
    await this.recordStoryGeneration();

    const players = await this.getPlayers();
    const nameOf = (playerId: string) => players.find((p) => p.id === playerId)?.name ?? playerId;
    // THE choke point: `{kind:"public"}` — see THE LEAK CONTRACT above.
    const view = projectFor(game!, { kind: "public" });

    let result: Awaited<ReturnType<typeof this.runStoryGeneration>>;
    try {
      result = await this.runStoryGeneration(view, msg.beat, nameOf, story);
    } finally {
      // Clear the in-flight record regardless of outcome so a genuine
      // success/failure never leaves the room falsely "busy" — the stale
      // bound above is only a backstop for an evicted DO, not the normal path.
      const current = await this.ctx.storage.get<StoryInflightRecord>(STORY_INFLIGHT_KEY);
      if (current?.requestId === record.requestId) {
        await this.ctx.storage.delete(STORY_INFLIGHT_KEY);
      }
    }

    logGenerate(result.outcome);
    const output = result.output;
    if (!output) {
      this.sendToHostSockets({ type: "story_error", requestId: msg.requestId, code: "generation_failed" });
      return;
    }

    // The draft TEXT is memory-only (never persisted) until auto-commit; it
    // rides straight to host sockets here and the caller (host UI) holds it
    // client-side until the beat is superseded.
    this.pendingDrafts.set(msg.requestId, {
      requestId: msg.requestId,
      beat: msg.beat,
      phaseGen: msg.phaseGen,
      day: view.day,
      text: output.scene,
      bibleUpdates: output.bibleUpdates,
    });
    this.sendToHostSockets({ type: "story_draft", requestId: msg.requestId, beat: msg.beat, phaseGen: msg.phaseGen, text: output.scene });
  }

  /** Runs (or fakes) the actual generation. Isolated so the try/finally in
   * the caller always clears the in-flight record even if this throws.
   * Returns BOTH the output and the specific outcome classification (Spec
   * 17 D1 needs to tell timeout/parse_fail/model_error apart in the
   * `story_generate` log, not just "failed"). */
  private async runStoryGeneration(
    view: ReturnType<typeof projectFor>,
    beat: BeatId,
    nameOf: (id: string) => string,
    story: StoryState,
  ): Promise<{ outcome: StoryGenerateOutcome; output: { scene: string; bibleUpdates: Record<string, string> } | null }> {
    const facts = buildStoryFacts(view, beat, nameOf);
    const memory: StoryMemory = { bible: story.bible, scenes: story.scenes };
    const settings: StorySettings = story.settings;

    if (this.env.STORYTELLER_FAKE === "1") {
      return { outcome: "ok", output: fakeStoryOutput(facts) };
    }

    const { system, user } = buildPrompt({ settings, memory, facts });
    try {
      // The model id is a runtime `STORYTELLER_MODEL` var, not a literal
      // type `Ai.run`'s overloads key on — call through a loosely-typed
      // handle rather than fighting the generated binding's model-name
      // overload resolution. `parseStoryOutput` defensively handles whatever
      // shape comes back regardless.
      const ai = this.env.AI as unknown as { run: (model: string, inputs: unknown) => Promise<unknown> };
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), STORY_AI_TIMEOUT_MS));
      const call = ai.run(this.env.STORYTELLER_MODEL, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 600,
        temperature: 0.8,
      });
      const raced = await Promise.race([call, timeout]);
      if (raced === null) return { outcome: "timeout", output: null };
      const output = parseStoryOutput(raced);
      return output ? { outcome: "ok", output } : { outcome: "parse_fail", output: null };
    } catch {
      return { outcome: "model_error", output: null };
    }
  }

  /** Host-only: drops the pending draft for `requestId` — nothing commits.
   * A discard for an unknown/already-superseded requestId is a harmless
   * no-op (the draft is already gone either way). */
  private async handleDiscardStory(
    ws: WebSocket,
    attachment: Attachment,
    msg: Extract<ClientMessage, { type: "discard_story" }>,
  ): Promise<void> {
    if (attachment.kind !== "host") {
      this.sendRejection(ws, "not_host");
      return;
    }
    this.pendingDrafts.delete(msg.requestId);
  }

  /** Auto-keep (spec §Product shape): the latest non-discarded draft for a
   * beat commits automatically when superseded — by a `generate_story` for a
   * DIFFERENT beat (handled implicitly: only one draft is ever pending, keyed
   * by requestId, and a new `generate_story` call overwrites it after
   * committing the old one here), a phase advance past the beat's legal
   * phase, or game end. Fire-safe: wrapped so a storyState write failure can
   * never block/fail the phase advance it piggybacks on, and it runs
   * STRICTLY AFTER the game-state transition (called from `applyGameResult`,
   * after the storage put + broadcast are queued). */
  private async autoCommitSupersededDrafts(newPhase: string, newGen: number): Promise<void> {
    if (this.pendingDrafts.size === 0) return;
    try {
      const story = await this.getStoryState();
      let next = story;
      let changed = false;
      for (const draft of this.pendingDrafts.values()) {
        const legalPhase = BEAT_PHASE[draft.beat];
        const stillLegal = newPhase === legalPhase && draft.phaseGen === newGen;
        if (stillLegal) continue; // beat hasn't been superseded yet
        next = commitDraft(next, draft);
        changed = true;
        this.pendingDrafts.delete(draft.requestId);
      }
      if (changed) await this.ctx.storage.put(STORY_STATE_KEY, next);
    } catch {
      // Fire-safe: a storyState write failure must never surface as a
      // phase-advance failure. The draft is simply lost; the host re-spins.
    }
  }

  /** Rate limit: 10 generations/min per room, DO-side `Date.now()` (server
   * layer, not engine — fine per spec). Stored as a rolling list of
   * timestamps; pruned on every check. */
  private async isStoryRateLimited(): Promise<boolean> {
    const now = Date.now();
    const timestamps = ((await this.ctx.storage.get<number[]>(STORY_RATE_LIMIT_KEY)) ?? []).filter((t) => now - t < 60_000);
    return timestamps.length >= STORY_RATE_LIMIT_PER_MIN;
  }

  private async recordStoryGeneration(): Promise<void> {
    const now = Date.now();
    const timestamps = ((await this.ctx.storage.get<number[]>(STORY_RATE_LIMIT_KEY)) ?? []).filter((t) => now - t < 60_000);
    timestamps.push(now);
    await this.ctx.storage.put(STORY_RATE_LIMIT_KEY, timestamps);
  }

  /** Sends `msg` to every currently-connected HOST socket (multi-host-device
   * is real: `hostConnected` is an OR today, never a count). Pattern-matched
   * to `handleKick`/`handleLeave`'s `socketsFor` + iterate + send. Player
   * sockets are NEVER a valid target for this helper — leak-tested. */
  private sendToHostSockets(msg: ServerMessage): void {
    for (const sock of socketsFor(this.ctx, (a) => a.kind === "host")) {
      this.send(sock, msg);
    }
  }

  private sendStoryError(ws: WebSocket, requestId: string, code: Extract<ServerMessage, { type: "story_error" }>["code"]): void {
    // story_error is host-only by contract, but this call site always
    // originates from a host-authenticated command — send directly to the
    // issuing socket (mirrors sendRejection) rather than broadcasting.
    this.send(ws, { type: "story_error", requestId, code });
  }

  /** Apply-persist-broadcast, in that order, atomically per message: no
   * `await` between the engine call (already happened in the caller) and the
   * storage put below. `room` may be passed in when the caller already holds
   * a fresh read (start_game) to avoid a redundant fetch; otherwise it's
   * re-read here. A `rejection` is sent only to the issuing socket — it
   * never closes the socket and never broadcasts. `original` lets a true
   * engine no-op (e.g. a stale `timerExpired` whose `at` no longer matches
   * `state.deadlineAt` — Spec 02 returns the same state reference, no
   * rejection) skip persisting and re-broadcasting an unchanged snapshot;
   * without this a stale alarm would still fan out a redundant frame to
   * every socket even though nothing changed. */
  private async applyGameResult(
    result: ReturnType<typeof applyCommand>,
    original: GameState | null,
    room?: RoomMeta,
    rejectTo?: WebSocket,
  ): Promise<void> {
    if (result.rejection) {
      if (rejectTo) {
        this.sendRejection(rejectTo, result.rejection.code);
      }
      return;
    }

    if (result.state === original) {
      return;
    }

    const meta = room ?? (await this.ctx.storage.get<RoomMeta>(ROOM_KEY));
    if (!meta) {
      return;
    }

    meta.phase = result.state.phase;
    meta.lastActivityAt = Date.now();
    await this.ctx.storage.put(GAME_KEY, result.state);
    await this.ctx.storage.put(ROOM_KEY, meta);
    await this.applyEffects(result.effects, result.state, meta);

    // Spec 15 auto-keep: runs STRICTLY AFTER the game-state transition above,
    // fire-safe (a storyState write failure here can never fail this phase
    // advance — see autoCommitSupersededDrafts's own try/catch).
    await this.autoCommitSupersededDrafts(result.state.phase, result.state.phaseGen);

    await this.touchAndBroadcast({ skipActivity: true });
  }

  /** `setDeadline`/`clearDeadline` land in the same storage transaction as
   * the state put above (no intervening await from the engine call); the
   * alarm itself is (re)armed afterward by touchAndBroadcast's call to
   * scheduleNextAlarm() — one scheduler, no second setAlarm call site. */
  private async applyEffects(effects: Effect[], state: GameState, meta: RoomMeta): Promise<void> {
    for (const effect of effects) {
      if (effect.type === "setDeadline") {
        await this.ctx.storage.put(GAME_DEADLINE_KEY, effect.at);
      } else if (effect.type === "clearDeadline") {
        await this.ctx.storage.delete(GAME_DEADLINE_KEY);
      } else if (effect.type === "gameEnded") {
        // The win reason lives on the log entry the engine pushed in the
        // same turn (`Effect` itself only carries `winners`) — find it
        // rather than re-deriving anything (§reason single source of truth).
        const logEntry = [...state.log].reverse().find(
          (e): e is Extract<GameEvent, { type: "gameEnded" }> => e.type === "gameEnded",
        );
        const startedAt = await this.ctx.storage.get<number>(GAME_STARTED_AT_KEY);
        const durationMs = startedAt !== undefined ? Date.now() - startedAt : 0;
        logEvent("game_ended", {
          roomCode: meta.code,
          winners: effect.winners,
          reason: logEntry?.reason ?? "unknown",
          day: state.day,
          durationMs,
        });
        writeMetric(this.env, { doubles: [state.day, durationMs], blobs: ["game_ended"], indexes: [meta.code] });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Close / error / hibernation
  // -------------------------------------------------------------------------

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    wasClean: boolean,
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.kind === "pending") {
      const pending =
        (await this.ctx.storage.get<PendingAuthEntry[]>(PENDING_AUTH_KEY)) ??
        [];
      const filtered = pending.filter((e) => e.tagId !== attachment.tagId);
      if (filtered.length !== pending.length) {
        await this.ctx.storage.put(PENDING_AUTH_KEY, filtered);
      }
    }
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (room) {
      logEvent("ws_close", { roomCode: room.code, authKind: attachment?.kind ?? "pending", code, wasClean });
    }
    ws.close(normalizeCloseCode(code));
    await this.touchAndBroadcast({ skipActivity: true });
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.kind === "pending") {
      const pending =
        (await this.ctx.storage.get<PendingAuthEntry[]>(PENDING_AUTH_KEY)) ??
        [];
      const filtered = pending.filter((e) => e.tagId !== attachment.tagId);
      if (filtered.length !== pending.length) {
        await this.ctx.storage.put(PENDING_AUTH_KEY, filtered);
      }
    }
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (room) {
      logEvent("ws_error", { roomCode: room.code });
    }
    await this.touchAndBroadcast({ skipActivity: true });
  }

  // -------------------------------------------------------------------------
  // Unified alarm scheduler — ONE alarm slot. Every deadline-affecting event
  // calls scheduleNextAlarm(); setAlarm() is called nowhere else in this file.
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();

    const pending =
      (await this.ctx.storage.get<PendingAuthEntry[]>(PENDING_AUTH_KEY)) ?? [];
    const expired = pending.filter((e) => now - e.connectedAt >= AUTH_REAP_MS);
    if (expired.length > 0) {
      const expiredIds = new Set(expired.map((e) => e.tagId));
      for (const entry of expired) {
        const sockets = liveSockets(this.ctx, `pending:${entry.tagId}`);
        for (const sock of sockets) {
          sock.close(CLOSE_AUTH_TIMEOUT);
        }
      }
      const remaining = pending.filter((e) => !expiredIds.has(e.tagId));
      await this.ctx.storage.put(PENDING_AUTH_KEY, remaining);
    }

    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (room) {
      const hasLiveSocket = liveSockets(this.ctx).length > 0;
      if (!hasLiveSocket) {
        const players = await this.getPlayers();
        const idleMs = now - room.lastActivityAt;
        const emptyLobby = room.phase === "lobby" && players.length === 0;
        const shouldWipeEmptyLobby = emptyLobby && idleMs >= EMPTY_LOBBY_TTL_MS;
        // Spec 17 D4: a room whose game has ENDED wipes at the 2h mark
        // (between the 1h empty-lobby path, which only ever applies in the
        // lobby, and the 6h absolute backstop below).
        const shouldWipeEndedTtl = room.phase === "ended" && idleMs >= ENDED_TTL_MS;
        const shouldWipeTtl = idleMs >= ABSOLUTE_TTL_MS;
        if (shouldWipeEmptyLobby || shouldWipeEndedTtl || shouldWipeTtl) {
          const reason = shouldWipeEmptyLobby ? "empty_lobby" : shouldWipeEndedTtl ? "ended_ttl" : "absolute_ttl";
          logEvent("room_wiped", { roomCode: room.code, reason, idleMs });
          writeMetric(this.env, { blobs: ["room_wiped", reason], indexes: [room.code] });
          await this.ctx.storage.deleteAll();
          return;
        }
      }
    }

    // Game deadline: read fresh from storage (never a value cached earlier
    // in this turn). If absent or not yet due, it's not this firing's
    // concern — skip and let scheduleNextAlarm() below re-arm for it. If
    // due, apply {timerExpired, at}; the engine itself validates
    // `at === state.deadlineAt` and no-ops otherwise, so an alarm that fires
    // for a deadline a force-advance already consumed is harmless IF that
    // force-advance armed a newer deadline — scheduleNextAlarm() then re-arms
    // for the newer value, not the stale one.
    //
    // But a stale gameDeadlineAt that will NEVER again match state.deadlineAt
    // (the game ended, or otherwise stopped arming deadlines) is a hot-loop
    // hazard: applyGameResult's no-op path returns before applyEffects runs,
    // so GAME_DEADLINE_KEY is never cleared, and scheduleNextAlarm() below
    // re-reads that same past-due value and re-arms on it — firing again
    // immediately, forever (prod incident, room JH3KD: 85ms-interval firing
    // for 4+ hours). Guard: after the no-op, if the key still holds this
    // EXACT value we just proved stale, delete it ourselves so nothing re-
    // arms on it. A real consumption (engine applied a setDeadline/
    // clearDeadline effect) has already changed or removed the key by now,
    // so this never clobbers the legitimate case.
    const gameDeadlineAt = await this.ctx.storage.get<number>(
      GAME_DEADLINE_KEY,
    );
    if (gameDeadlineAt !== undefined && now >= gameDeadlineAt) {
      const game = await this.ctx.storage.get<GameState>(GAME_KEY);
      if (game && room) {
        const driftMs = now - gameDeadlineAt;
        logEvent("alarm_fired", { roomCode: room.code, kind: "game_deadline", driftMs });
        writeMetric(this.env, { doubles: [driftMs], blobs: ["alarm_drift"], indexes: [room.code] });
        const result = applyCommand(game, {
          type: "timerExpired",
          at: gameDeadlineAt,
          now,
        });
        await this.applyGameResult(result, game);

        const stillStale = await this.ctx.storage.get<number>(GAME_DEADLINE_KEY);
        if (stillStale === gameDeadlineAt) {
          await this.ctx.storage.delete(GAME_DEADLINE_KEY);
        }
      }
    }

    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room) {
      return;
    }

    const deadlines: number[] = [];

    const pending =
      (await this.ctx.storage.get<PendingAuthEntry[]>(PENDING_AUTH_KEY)) ?? [];
    for (const entry of pending) {
      deadlines.push(entry.connectedAt + AUTH_REAP_MS);
    }

    const hasLiveSocket = liveSockets(this.ctx).length > 0;
    if (!hasLiveSocket) {
      const players = await this.getPlayers();
      if (room.phase === "lobby" && players.length === 0) {
        deadlines.push(room.lastActivityAt + EMPTY_LOBBY_TTL_MS);
      }
      deadlines.push(room.lastActivityAt + ABSOLUTE_TTL_MS);
    }

    const gameDeadlineAt = await this.ctx.storage.get<number>(
      GAME_DEADLINE_KEY,
    );
    if (gameDeadlineAt !== undefined) {
      deadlines.push(gameDeadlineAt);
    }

    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const next = Math.min(...deadlines);
    await this.ctx.storage.setAlarm(next);
  }

  // -------------------------------------------------------------------------
  // Snapshot / broadcast helpers
  // -------------------------------------------------------------------------

  private async getPlayers(): Promise<PlayerRecord[]> {
    return (await this.ctx.storage.get<PlayerRecord[]>(PLAYERS_KEY)) ?? [];
  }

  private async buildStateFor(
    viewer: { kind: "host" } | { kind: "player"; playerId: string },
  ): Promise<ClientRoomState> {
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room) {
      throw new Error("buildStateFor called with no room");
    }
    const players = await this.getPlayers();
    const hostConnected =
      socketsFor(this.ctx, (a) => a.kind === "host").length > 0;

    const views: ClientPlayerView[] = players.map((p) => ({
      id: p.id,
      name: p.name,
      connected:
        socketsFor(
          this.ctx,
          (a) => a.kind === "player" && a.playerId === p.id,
        ).length > 0,
      isYou: viewer.kind === "player" && viewer.playerId === p.id,
    }));

    const game = await this.ctx.storage.get<GameState>(GAME_KEY);
    const gameView = game
      ? projectFor(
          game,
          viewer.kind === "host"
            ? { kind: "host" }
            : { kind: "player", id: viewer.playerId },
        )
      : null;

    // Spec 06 D1 / Spec 11: broadcast the pending ruleset only while in the
    // lobby (roster preview) — once a game is running the chosen ruleset lives
    // in `game`, so this is null to avoid a stale duplicate.
    // Spec 17 D4 (deliberate, not a leak/bug): PENDING_RULESET_KEY itself is
    // never deleted at start_game — it's gated out of snapshots mid-game by
    // the `game ? null : ...` above, and surviving in storage preserves the
    // host's role-count choices for the rematch lobby (handleNewGame doesn't
    // touch it either).
    const pendingRuleset = game
      ? null
      : ((await this.ctx.storage.get<Ruleset>(PENDING_RULESET_KEY)) ?? null);

    // Spec 15 (M5): host-only field — populated ONLY for a host viewer, never
    // for a player (leak-tested). Carries settings + bible + KEPT scenes
    // only; a pending draft never rides here (it's ephemeral, delivered via
    // `story_draft` instead).
    const story = viewer.kind === "host" ? await this.getStoryState() : null;
    const visualTheme = readVisualTheme(room);

    return {
      roomCode: room.code,
      phase: game ? game.phase : "lobby",
      players: views,
      hostConnected,
      createdAt: room.createdAt,
      visualTheme: visualTheme.visualTheme,
      visualThemeRevision: visualTheme.visualThemeRevision,
      game: gameView,
      pendingRuleset: pendingRuleset as ClientRoomState["pendingRuleset"],
      story,
    };
  }

  /** Recompute lastActivityAt (unless skipped) and push a fresh personalized
   * snapshot to every connected socket, then re-arm the alarm. Called after
   * every state-changing event. `excludeWs` skips the socket that just got a
   * `welcome` reply on this same hello — that message already carries the
   * current state, so re-sending a snapshot to it immediately after would be
   * a redundant duplicate. */
  private async touchAndBroadcast(opts?: {
    skipActivity?: boolean;
    excludeWs?: WebSocket;
  }): Promise<void> {
    const room = await this.ctx.storage.get<RoomMeta>(ROOM_KEY);
    if (!room) {
      return;
    }

    if (!opts?.skipActivity) {
      room.lastActivityAt = Date.now();
      await this.ctx.storage.put(ROOM_KEY, room);
    }

    const serverNow = Date.now();
    for (const sock of liveSockets(this.ctx)) {
      if (sock === opts?.excludeWs) {
        continue;
      }
      const attachment = sock.deserializeAttachment() as Attachment | null;
      if (!attachment || attachment.kind === "pending") {
        continue;
      }
      const state = await this.buildStateFor(
        attachment.kind === "host"
          ? { kind: "host" }
          : { kind: "player", playerId: attachment.playerId },
      );
      this.send(sock, { type: "snapshot", state, serverNow });
    }

    await this.scheduleNextAlarm();
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }

  private sendRejection(ws: WebSocket, code: string): void {
    this.send(ws, { type: "rejection", code });
  }
}
