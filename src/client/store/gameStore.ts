// Single zustand store (D3). Hydrated exclusively from `RoomConnection`
// events (welcome/snapshot/rejection/error/status) — no other data source,
// per the spec's pinned architecture. Screens are pure renders of this
// store; every user intent goes out as a protocol message via
// `RoomConnection.send()`. `previousPhase` is the one UI-only field: it
// exists purely so the phase-tint transition knows a change just happened
// (300ms fade), and is never read for any game-logic decision.
import { toast } from "sonner";
import { create } from "zustand";
import type { ClientMessage, ClientRoomState, ErrorMessage } from "../../shared/protocol";
import type { Phase } from "../../shared/game-view";
import type { Auth, ConnectionStatus, WelcomeInfo } from "../net/RoomConnection";
import { RoomConnection } from "../net/RoomConnection";

/** Lifecycle-only hooks a caller (Room.tsx) can layer on top of the store's
 * own hydration handling — auth resolution (seat/hostKey persistence,
 * kicked, bad-credential) is Spec 01 lifecycle logic that isn't game state,
 * so it doesn't belong in the store itself, but there's still only ONE
 * `RoomConnection` instance: the store constructs it and forwards these. */
export interface RoomLifecycleHooks {
  onWelcome?: (info: WelcomeInfo) => void;
  onKicked?: () => void;
  onBadCredential?: () => void;
  onError?: (err: ErrorMessage) => void;
}

/** Human copy for rejection codes the player-facing UI can actually trigger
 * (submit_action / cast_vote / retract_vote / force_advance rejections).
 * Unlisted codes still surface — just with the raw code as fallback text —
 * so a future rejection code is never silently swallowed. */
const REJECTION_COPY: Record<string, string> = {
  not_your_phase: "You can't do that right now.",
  not_your_turn: "It's not your turn.",
  stale_advance: "The game already moved on.",
  not_alive: "The dead don't get a vote.",
  invalid_target: "That's not a valid target.",
  no_game: "There's no game running.",
  game_not_started: "The game hasn't started yet.",
  no_pick_to_lock: "Choose a target before locking in.",
  not_lockable: "You can't lock in right now.",
};

function rejectionMessage(code: string): string {
  return REJECTION_COPY[code] ?? `Rejected: ${code}`;
}

interface GameStoreState {
  connection: ConnectionStatus;
  room: ClientRoomState | null;
  isHost: boolean;
  playerId: string | null;
  /** The phase from the snapshot immediately prior to the current one —
   * UI-only presentation memory for the phase-tint fade, never consulted
   * for any game-logic decision. `null` until the first phase is known. */
  previousPhase: Phase | "lobby" | null;
  lastError: ErrorMessage | null;
  conn: RoomConnection | null;
  /** `serverNow - Date.now()` sampled at the moment of the most recent
   * welcome/snapshot — countdowns add this to `Date.now()` rather than
   * trusting the local clock (spec pin: "never raw Date.now()"). Re-sampled
   * on every message, not just once per connection, so a long-lived
   * connection's drift correction stays fresh. */
  clockOffsetMs: number;

  connect: (code: string, auth: Auth, hooks?: RoomLifecycleHooks) => RoomConnection;
  disconnect: () => void;
  reset: () => void;
  send: (msg: ClientMessage) => void;
}

/** `you` / `game` are read off `room.game` directly by screens (that's the
 * exact `ClientGameView` shape the projection hands us) — no separate copy
 * is kept in the store, so there is exactly one place a screen can go to
 * find out what it's allowed to know. */
export const useGameStore = create<GameStoreState>()((set, get) => ({
  connection: "connecting",
  room: null,
  isHost: false,
  playerId: null,
  previousPhase: null,
  lastError: null,
  conn: null,
  clockOffsetMs: 0,

  connect: (code, auth, hooks) => {
    get().conn?.close();
    const conn = new RoomConnection(code, auth, {
      onStatusChange: (status) => set({ connection: status }),
      onWelcome: (info) => {
        // A fresh `join` only mints a seat token on the FIRST welcome —
        // every reconnect within this same page session must present that
        // seat token, not replay the original `join`, or the server
        // rightly rejects it once the game has started (`game_in_progress`)
        // and the socket never authenticates: it sits "pendingAuth" until
        // the server's own reap timeout kills it, and the client retries
        // with the same stale `join` forever (this was a real, confirmed
        // infinite reconnect-cycling bug — Spec 04 fix-round-4). `Room.tsx`
        // already persists the seat token to storage for a future page
        // reload; this is the missing piece for reconnects that happen
        // WITHOUT a reload, on this same `RoomConnection` instance.
        if (info.seatToken) {
          conn.setAuth({ kind: "seat", seatToken: info.seatToken });
        }
        set((s) => ({
          room: info.state,
          isHost: info.isHost,
          playerId: info.playerId ?? s.playerId,
          previousPhase: info.state.phase,
          clockOffsetMs: info.serverNow - Date.now(),
        }));
        hooks?.onWelcome?.(info);
      },
      onSnapshot: (state, serverNow) => {
        set((s) => ({
          room: state,
          previousPhase: s.room?.phase ?? state.phase,
          clockOffsetMs: serverNow - Date.now(),
        }));
      },
      onRejection: (rejection) => {
        toast(rejectionMessage(rejection.code));
      },
      onError: (err) => {
        set({ lastError: err });
        hooks?.onError?.(err);
      },
      onKicked: () => hooks?.onKicked?.(),
      onBadCredential: () => hooks?.onBadCredential?.(),
    });
    set({ conn });
    return conn;
  },

  disconnect: () => {
    get().conn?.close();
    set({ conn: null });
  },

  reset: () => {
    get().conn?.close();
    set({
      connection: "connecting",
      room: null,
      isHost: false,
      playerId: null,
      previousPhase: null,
      lastError: null,
      conn: null,
      clockOffsetMs: 0,
    });
  },

  send: (msg) => {
    get().conn?.send(msg);
  },
}));

// ---------------------------------------------------------------------------
// Intent helpers (D3). Thin wrappers that build the exact protocol message —
// no client-side game logic, just message construction.
// ---------------------------------------------------------------------------

export function submitAction(targetId: string | null): void {
  useGameStore.getState().send({
    type: "submit_action",
    action: { targetId },
  });
}

export function castVote(target: string): void {
  useGameStore.getState().send({ type: "cast_vote", target });
}

export function retractVote(): void {
  useGameStore.getState().send({ type: "retract_vote" });
}

export function confirmVote(): void {
  useGameStore.getState().send({ type: "confirm_vote" });
}

export function unconfirmVote(): void {
  useGameStore.getState().send({ type: "unconfirm_vote" });
}

export function acknowledge(gen: number): void {
  useGameStore.getState().send({ type: "acknowledge", gen });
}

export function setRuleset(ruleset: unknown): void {
  useGameStore.getState().send({ type: "set_ruleset", ruleset });
}

export function lockAction(): void {
  useGameStore.getState().send({ type: "lock_action" });
}

export function unlockAction(): void {
  useGameStore.getState().send({ type: "unlock_action" });
}

export function markAbsent(playerId: string): void {
  useGameStore.getState().send({ type: "mark_absent", playerId });
}

export function markPresent(playerId: string): void {
  useGameStore.getState().send({ type: "mark_present", playerId });
}

export function forceAdvance(gen: number): void {
  useGameStore.getState().send({ type: "force_advance", gen });
}

export function kickPlayer(playerId: string): void {
  useGameStore.getState().send({ type: "kick", playerId });
}

export function startGame(ruleset: unknown, seed?: number): void {
  useGameStore
    .getState()
    .send(
      seed === undefined
        ? { type: "start_game", ruleset }
        : { type: "start_game", ruleset, seed },
    );
}

export function newGame(): void {
  useGameStore.getState().send({ type: "new_game" });
}

/** Drift-corrected "now" — `Date.now()` plus the offset sampled from the
 * server's own clock at the last welcome/snapshot. Countdown UI must use
 * this, never raw `Date.now()` (spec pin: skewed phone clocks are common). */
export function serverNow(): number {
  return Date.now() + useGameStore.getState().clockOffsetMs;
}
