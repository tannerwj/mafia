import { DurableObject } from "cloudflare:workers";
import type {
  ClientMessage,
  ClientPlayerView,
  ClientRoomState,
  ErrorCode,
  ServerMessage,
} from "../shared/protocol";
import {
  CLOSE_AUTH_TIMEOUT,
  CLOSE_BAD_CREDENTIAL,
  CLOSE_KICKED,
} from "../shared/protocol";
import {
  applyCommand,
  projectFor,
  startGame,
  validateRuleset,
  type Command,
  type Effect,
  type GameState,
  type LobbyPlayer,
  type Ruleset,
} from "../engine";

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
const PLAYERS_KEY = "players";
const PENDING_AUTH_KEY = "pendingAuth";
const GAME_KEY = "game";
const GAME_DEADLINE_KEY = "gameDeadlineAt";

const AUTH_REAP_MS = 30_000;
const EMPTY_LOBBY_TTL_MS = 60 * 60 * 1000; // 1h
const ABSOLUTE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

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

export class GameRoom extends DurableObject<Env> {
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
    };
    await this.ctx.storage.put(ROOM_KEY, room);
    await this.ctx.storage.put(PLAYERS_KEY, [] as PlayerRecord[]);
    await this.scheduleNextAlarm();
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

  override async webSocketMessage(
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
        this.sendError(ws, "bad_host_key", "Invalid host key.");
        ws.close(CLOSE_BAD_CREDENTIAL);
        return;
      }
      await this.completeAuth(ws, attachment, { kind: "host" });
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
        this.sendError(ws, "bad_seat_token", "Unknown seat token.");
        ws.close(CLOSE_BAD_CREDENTIAL);
        return;
      }
      await this.completeAuth(ws, attachment, {
        kind: "player",
        playerId: player.id,
      });
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

    const seed =
      this.env.ALLOW_TEST_SEED === "1" && msg.seed !== undefined
        ? msg.seed
        : crypto.getRandomValues(new Uint32Array(1))[0]!;

    const lobbyPlayers: LobbyPlayer[] = players.map((p) => ({
      id: p.id,
      name: p.name,
    }));
    const result = startGame(lobbyPlayers, ruleset, seed, Date.now());
    await this.applyGameResult(result, null, room);
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
    room.phase = "lobby";
    await this.ctx.storage.put(ROOM_KEY, room);
    await this.touchAndBroadcast();
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
    await this.applyEffects(result.effects);

    await this.touchAndBroadcast({ skipActivity: true });
  }

  /** `setDeadline`/`clearDeadline` land in the same storage transaction as
   * the state put above (no intervening await from the engine call); the
   * alarm itself is (re)armed afterward by touchAndBroadcast's call to
   * scheduleNextAlarm() — one scheduler, no second setAlarm call site. */
  private async applyEffects(effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.type === "setDeadline") {
        await this.ctx.storage.put(GAME_DEADLINE_KEY, effect.at);
      } else if (effect.type === "clearDeadline") {
        await this.ctx.storage.delete(GAME_DEADLINE_KEY);
      } else if (effect.type === "gameEnded") {
        // Nothing beyond the normal broadcast — the ended state and winners
        // are already in `result.state`/the projected view.
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
    _wasClean: boolean,
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
        const emptyLobby = room.phase === "lobby" && players.length === 0;
        const shouldWipeEmptyLobby =
          emptyLobby && now - room.lastActivityAt >= EMPTY_LOBBY_TTL_MS;
        const shouldWipeTtl = now - room.lastActivityAt >= ABSOLUTE_TTL_MS;
        if (shouldWipeEmptyLobby || shouldWipeTtl) {
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
    // for a deadline a force-advance already consumed is harmless.
    const gameDeadlineAt = await this.ctx.storage.get<number>(
      GAME_DEADLINE_KEY,
    );
    if (gameDeadlineAt !== undefined && now >= gameDeadlineAt) {
      const game = await this.ctx.storage.get<GameState>(GAME_KEY);
      if (game) {
        const result = applyCommand(game, {
          type: "timerExpired",
          at: gameDeadlineAt,
          now,
        });
        await this.applyGameResult(result, game);
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

    return {
      roomCode: room.code,
      phase: game ? game.phase : "lobby",
      players: views,
      hostConnected,
      createdAt: room.createdAt,
      game: gameView,
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
