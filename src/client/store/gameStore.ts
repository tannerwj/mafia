// Single zustand store (D3). Hydrated exclusively from `RoomConnection`
// events (welcome/snapshot/rejection/error/status) — no other data source,
// per the spec's pinned architecture. Screens are pure renders of this
// store; every user intent goes out as a protocol message via
// `RoomConnection.send()`. `previousPhase` is the one UI-only field: it
// exists purely so the phase-tint transition knows a change just happened
// (300ms fade), and is never read for any game-logic decision.
import { toast } from "sonner";
import { create } from "zustand";
import type { BeatId, ClientMessage, ClientRoomState, ErrorMessage, Tone } from "../../shared/protocol";
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
  reveal_not_active: "There's no scene to reveal right now.",
};

function rejectionMessage(code: string): string {
  return REJECTION_COPY[code] ?? `Rejected: ${code}`;
}

/** Spec 15. Human copy for `story_error` codes — surfaced in the draft panel,
 * not as a toast (the Storyteller card is where the host is already looking
 * when this fires). */
const STORY_ERROR_COPY: Record<string, string> = {
  disabled: "The Storyteller is off. Turn it on in the setup card first.",
  busy: "Already spinning a tale — hang tight.",
  rate_limited: "Too many scenes too fast — give it a minute.",
  stale_story: "The scene moved on before this one finished.",
  wrong_phase: "There's no scene to spin right now.",
  generation_failed: "The muse is silent — try again.",
};

/** Spec 15. A not-yet-committed draft, held ONLY in client state (§Memory:
 * "pending drafts are ephemeral by design") — a reload loses it; the host
 * simply re-spins. `status` tracks the round trip; `error` is set instead of
 * `text` on a `story_error` reply for this requestId. */
export interface StoryDraft {
  requestId: string;
  beat: BeatId;
  phaseGen: number;
  status: "pending" | "ready" | "error";
  text?: string;
  error?: string;
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
  /** Spec 15. The current draft-in-flight-or-ready, host-console-only,
   * ephemeral (never rides a snapshot). `null` once discarded/committed/
   * dropped-as-stale. Only one at a time — a fresh `generate_story` (Re-spin
   * included) replaces it, mirroring the server's own queue-of-one. */
  storyDraft: StoryDraft | null;

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
  storyDraft: null,

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
        set((s) => {
          // Spec 15: a slow draft for a beat the game has since moved past
          // renders nowhere — drop it the moment phaseGen advances beyond
          // what the draft was generated for (mirrors the server's own
          // phaseGen staleness check on the way in).
          const currentGen = state.game?.phaseGen;
          const draftIsStale = s.storyDraft && currentGen !== undefined && currentGen !== s.storyDraft.phaseGen;
          return {
            room: state,
            previousPhase: s.room?.phase ?? state.phase,
            clockOffsetMs: serverNow - Date.now(),
            storyDraft: draftIsStale ? null : s.storyDraft,
          };
        });
      },
      onRejection: (rejection) => {
        toast(rejectionMessage(rejection.code));
      },
      onStoryDraft: (msg) => {
        set((s) => {
          // A draft only replaces the CURRENT one if it's still the request
          // we're waiting on (a Re-spin already moved storyDraft to a newer
          // requestId, or a Discard already cleared it — either way an
          // in-flight response for the OLD request must not clobber that).
          if (s.storyDraft && s.storyDraft.requestId !== msg.requestId) return {};
          return { storyDraft: { requestId: msg.requestId, beat: msg.beat, phaseGen: msg.phaseGen, status: "ready", text: msg.text } };
        });
      },
      onStoryError: (msg) => {
        set((s) => {
          if (s.storyDraft && s.storyDraft.requestId !== msg.requestId) return {};
          if (!s.storyDraft) return {};
          return { storyDraft: { ...s.storyDraft, status: "error", error: STORY_ERROR_COPY[msg.code] ?? msg.code } };
        });
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
      storyDraft: null,
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

export function reveal(gen: number): void {
  useGameStore.getState().send({ type: "reveal", gen });
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

// ---------------------------------------------------------------------------
// Spec 15 — Storyteller intent helpers. `generateStory` mints its own
// `requestId` (crypto.randomUUID) and optimistically sets the local
// `storyDraft` to "pending" — the server's `story_draft`/`story_error` reply
// resolves it (or a snapshot drops it if the beat goes stale first).
// ---------------------------------------------------------------------------

export function setStorySettings(enabled: boolean, theme: string, tone: Tone): void {
  useGameStore.getState().send({ type: "set_story_settings", enabled, theme, tone });
}

export function generateStory(beat: BeatId, phaseGen: number): void {
  const requestId = crypto.randomUUID();
  useGameStore.setState({ storyDraft: { requestId, beat, phaseGen, status: "pending" } });
  useGameStore.getState().send({ type: "generate_story", beat, phaseGen, requestId });
}

export function discardStory(): void {
  const draft = useGameStore.getState().storyDraft;
  if (!draft) return;
  useGameStore.getState().send({ type: "discard_story", requestId: draft.requestId });
  useGameStore.setState({ storyDraft: null });
}

/** Drift-corrected "now" — `Date.now()` plus the offset sampled from the
 * server's own clock at the last welcome/snapshot. Countdown UI must use
 * this, never raw `Date.now()` (spec pin: skewed phone clocks are common). */
export function serverNow(): number {
  return Date.now() + useGameStore.getState().clockOffsetMs;
}
