import type {
  ClientMessage,
  ClientRoomState,
  ErrorMessage,
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
  /** Terminal close — bad_host_key or bad_seat_token. The credential that
   * was presented should be discarded by the caller. */
  onBadCredential?: () => void;
}

const HEARTBEAT_SEND_INTERVAL_MS = 25_000;
const LIVENESS_TIMEOUT_MS = 40_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;
const HEARTBEAT_TICK_MS = 5_000;

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
  private closedByUs = false;
  private terminal = false;

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
    window.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("pageshow", this.handleVisibility);
    window.removeEventListener("online", this.handleOnline);
    this.ws?.close(1000);
    this.ws = null;
  }

  private setStatus(status: ConnectionStatus): void {
    this.events.onStatusChange?.(status);
  }

  private connect(): void {
    if (this.terminal) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${location.host}/api/rooms/${encodeURIComponent(this.roomCode)}/ws`,
    );
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.attempt = 0;
      const now = Date.now();
      this.lastSentAt = now;
      this.lastMessageAt = now;
      this.send({ type: "hello", auth: this.auth });
    });

    ws.addEventListener("message", (event) => {
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
      this.ws = null;
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
        this.events.onError?.(msg);
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
