import type {
  ClientMessage,
  ClientRoomState,
  ErrorMessage,
  RejectionMessage,
  ServerMessage,
} from "../../shared/protocol";
import { CLOSE_BAD_CREDENTIAL, CLOSE_KICKED } from "../../shared/protocol";

export type Auth =
  | { kind: "host"; hostKey: string }
  | { kind: "seat"; seatToken: string }
  | { kind: "join"; name: string };

export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"; // terminal — 4001 or 4003, caller must not reconnect

export interface WelcomeInfo {
  playerId: string | undefined;
  seatToken: string | undefined;
  isHost: boolean;
  state: ClientRoomState;
}

export interface RoomConnectionEvents {
  onStatusChange?: (status: ConnectionStatus) => void;
  onWelcome?: (info: WelcomeInfo) => void;
  onSnapshot?: (state: ClientRoomState) => void;
  onKicked?: () => void;
  onError?: (err: ErrorMessage) => void;
  /** A normal in-game command rejection (e.g. `not_your_phase`) — never
   * closes the socket. Surfaced as a toast, not a thrown error. */
  onRejection?: (rejection: RejectionMessage) => void;
  /** Terminal close — bad_host_key or bad_seat_token. The credential that
   * was presented should be discarded by the caller. */
  onBadCredential?: () => void;
}

const HEARTBEAT_SEND_INTERVAL_MS = 25_000;
const LIVENESS_TIMEOUT_MS = 40_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;
const HEARTBEAT_TICK_MS = 5_000;
// The server reaps a socket that never completes `hello` after 30s
// (`AUTH_REAP_MS` in src/server/game-room.ts) — that reap is correct
// behavior for a genuinely stuck auth handshake, not a bug to route around.
// But a client that already knows its own `hello` went unanswered
// shouldn't wait out the SERVER's cleanup timer to notice: on a flaky
// connection a lost `hello`/`welcome` frame should cost this client a few
// seconds, not up to 30. If neither `welcome` nor `error` arrives within
// this window of sending `hello`, treat the attempt as failed and recycle
// immediately into the normal backoff/retry path (still fully
// spec-conformant — CLOSE_AUTH_TIMEOUT is already retryable; this just
// fails faster than waiting for the server to say so).
const AUTH_RESPONSE_TIMEOUT_MS = 5_000;

/**
 * Owns a single WebSocket to a room's DO, re-authenticating with `auth` on
 * every (re)connect, and auto-reconnecting with backoff + full jitter until a
 * terminal close code (4001 kicked, 4003 bad credential) is received.
 *
 * Liveness is wall-clock, not tick-count (mobile browsers throttle/suspend
 * timers) — see `checkLiveness`, called on a plain interval AND eagerly on
 * visibility/pageshow/online events, since the resume path is the primary
 * defense, not the cadence.
 */
export class RoomConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private lastSentAt = 0;
  private lastMessageAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private authTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private terminal = false;
  // Bumped by every `connect()` call; each socket's event listeners close
  // over the generation they were created for. `forceRecycle()` replaces
  // `this.ws` synchronously but the OLD socket's own `close()` call is
  // asynchronous — its `close`/`message`/`open` events can still fire later
  // and, without this guard, would mutate `this.ws`/`this.attempt`/
  // `lastMessageAt` using a stale socket's data, stomping the state of the
  // socket that actually replaced it (root cause of the reconnect-cycling
  // bug: a stale socket's `close` handler unconditionally wrote
  // `this.ws = null` over an already-healthy newer socket, silently
  // breaking `send()` — the mute state disguised itself as a "still
  // reconnecting" cycle from the outside). Every listener must check
  // `gen === this.generation` before touching shared state.
  private generation = 0;

  constructor(
    private readonly roomCode: string,
    private auth: Auth,
    private readonly events: RoomConnectionEvents,
  ) {
    this.handleVisibility = this.handleVisibility.bind(this);
    this.handleOnline = this.handleOnline.bind(this);
    window.addEventListener("visibilitychange", this.handleVisibility);
    window.addEventListener("pageshow", this.handleVisibility);
    window.addEventListener("online", this.handleOnline);
    this.heartbeatTimer = setInterval(
      () => this.heartbeatTick(),
      HEARTBEAT_TICK_MS,
    );
    this.connect();
  }

  /** Swap the credential used on the next (re)connect, e.g. after a fresh
   * join mints a seat token that should be used for subsequent reconnects. */
  setAuth(auth: Auth): void {
    this.auth = auth;
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closedByUs = true;
    this.terminal = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.authTimeoutTimer) clearTimeout(this.authTimeoutTimer);
    window.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("pageshow", this.handleVisibility);
    window.removeEventListener("online", this.handleOnline);
    this.ws?.close(1000);
    this.ws = null;
  }

  private clearAuthTimeout(): void {
    if (this.authTimeoutTimer) {
      clearTimeout(this.authTimeoutTimer);
      this.authTimeoutTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.events.onStatusChange?.(status);
  }

  private connect(): void {
    if (this.terminal) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const gen = ++this.generation;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${location.host}/api/rooms/${encodeURIComponent(this.roomCode)}/ws`,
    );
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (gen !== this.generation) return;
      this.attempt = 0;
      const now = Date.now();
      this.lastSentAt = now;
      this.lastMessageAt = now;
      this.send({ type: "hello", auth: this.auth });
      // Don't wait out the server's 30s `AUTH_REAP_MS` to notice a `hello`
      // that never gets answered (lost frame, bad credential the server is
      // slow to reject, etc.) — recycle after a short client-side window
      // instead. `forceRecycle()` bumps the generation, so a genuinely
      // in-flight `welcome` for THIS socket that arrives a moment late is
      // safely ignored by the generation guard rather than corrupting state.
      if (this.authTimeoutTimer) clearTimeout(this.authTimeoutTimer);
      this.authTimeoutTimer = setTimeout(() => {
        if (gen !== this.generation) return;
        this.authTimeoutTimer = null;
        this.forceRecycle();
      }, AUTH_RESPONSE_TIMEOUT_MS);
    });

    ws.addEventListener("message", (event) => {
      if (gen !== this.generation) return;
      this.lastMessageAt = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    ws.addEventListener("close", (event) => {
      // A stale (already-superseded) socket's `close` event must never
      // touch `this.ws`/`this.attempt`/scheduling — `forceRecycle()`
      // replaces `this.ws` synchronously, but the discarded socket's own
      // `.close()` call resolves asynchronously and this listener can fire
      // well after a newer, healthy socket has taken over.
      if (gen !== this.generation) return;
      this.ws = null;
      this.clearAuthTimeout();
      if (this.closedByUs) return;

      if (event.code === CLOSE_KICKED) {
        this.terminal = true;
        this.setStatus("closed");
        this.events.onKicked?.();
        return;
      }
      if (event.code === CLOSE_BAD_CREDENTIAL) {
        this.terminal = true;
        this.setStatus("closed");
        this.events.onBadCredential?.();
        return;
      }
      // CLOSE_AUTH_TIMEOUT and everything else (network/transient) are
      // retryable — normal reconnect backoff, re-send hello on the new socket.
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // The subsequent close event drives reconnect logic.
    });
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        this.clearAuthTimeout();
        this.setStatus("open");
        this.events.onWelcome?.({
          playerId: msg.you.playerId,
          seatToken: msg.you.seatToken,
          isHost: msg.you.isHost,
          state: msg.state,
        });
        return;
      case "snapshot":
        this.events.onSnapshot?.(msg.state);
        return;
      case "kicked":
        this.events.onKicked?.();
        return;
      case "error":
        // A `hello` this socket sent was answered (even as a rejection,
        // e.g. `game_in_progress` for a stale `join` credential) — the
        // auth-response wait is over either way; don't also fire the
        // timeout's own recycle a moment later on top of whatever the
        // caller does with this error.
        this.clearAuthTimeout();
        this.events.onError?.(msg);
        return;
      case "rejection":
        this.events.onRejection?.(msg);
        return;
      case "pong":
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.terminal) return;
    this.setStatus("reconnecting");
    const exp = Math.min(
      BACKOFF_CAP_MS,
      BACKOFF_BASE_MS * 2 ** this.attempt,
    );
    const delay = Math.random() * exp; // full jitter
    this.attempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private forceRecycle(): void {
    if (this.terminal) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearAuthTimeout();
    this.ws?.close();
    this.ws = null;
    this.attempt = 0;
    this.connect();
  }

  private heartbeatTick(): void {
    if (this.terminal || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const now = Date.now();
    if (now - this.lastMessageAt > LIVENESS_TIMEOUT_MS) {
      this.forceRecycle();
      return;
    }
    if (now - this.lastSentAt > HEARTBEAT_SEND_INTERVAL_MS) {
      this.lastSentAt = now;
      this.send({ type: "ping" });
    }
  }

  private checkLivenessNow(): void {
    if (this.terminal) return;
    const now = Date.now();
    const dead =
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      now - this.lastMessageAt > LIVENESS_TIMEOUT_MS;
    if (dead) {
      this.forceRecycle();
    }
  }

  private handleVisibility(): void {
    if (document.visibilityState === "visible") {
      this.checkLivenessNow();
    }
  }

  private handleOnline(): void {
    this.checkLivenessNow();
  }
}
