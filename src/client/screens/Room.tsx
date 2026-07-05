import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { ErrorMessage } from "../../shared/protocol";
import { shareOrCopyLink } from "../lib/shareLink";
import {
  appendSeatBackup,
  getHostKeyBackup,
  getSeatBackups,
  getSessionHostKey,
  getSessionSeat,
  removeSeatBackup,
  setSessionHostKey,
  setSessionSeat,
} from "../net/identity";
import { HOUSE_RULESET, testRolesOverride, testSeedOverride } from "../lib/houseRuleset";
import type { Auth } from "../net/RoomConnection";
import { useGameStore } from "../store/gameStore";
import { navigate } from "../useRoute";
import ConnectionBanner from "./ConnectionBanner";
import GameScreen from "./game/GameScreen";
import HostGame from "./host/HostGame";
import HostGameEnd from "./host/HostGameEnd";
import HostLobby from "./host/HostLobby";
import IdentityChooser from "./IdentityChooser";
import Lobby from "./Lobby";
import SeatPicker from "./SeatPicker";

type Phase =
  | { name: "resolving-auth" }
  // Dual-credential pin (Spec 05 D-conventions): this browser holds both a
  // hostKey and a seatToken for this room — `hello` must present exactly the
  // chosen one, never auto-picked by storage-read order.
  | { name: "choosing-identity"; hostKey: string; seatToken: string; seatName: string }
  // Host-key recovery pin: localStorage holds this room's hostKey backup but
  // THIS session doesn't (e.g. a dead host phone, a fresh tab) — offer an
  // explicit "Resume as host" action rather than silently auto-connecting
  // with a credential the current session never actually held.
  | { name: "offering-host-recovery"; hostKey: string }
  | { name: "picking-seat" }
  | { name: "connected"; isHost: boolean }
  | { name: "kicked" }
  | { name: "bad-credential" };

export default function Room({ code }: { code: string }) {
  const [phase, setPhase] = useState<Phase>({ name: "resolving-auth" });
  const [lastError, setLastError] = useState<ErrorMessage | null>(null);
  // Set only when both the native share sheet AND the clipboard are
  // unavailable/denied — surfaces the room URL in a visible, selectable field
  // so the host can long-press-copy it. Never a silent no-op.
  const [manualShareUrl, setManualShareUrl] = useState<string | null>(null);

  // The store owns the single RoomConnection instance and all game-state
  // hydration (D3). Room.tsx layers only the auth-resolution/lifecycle
  // phase machine that already lived here in Spec 01 (picking-seat/kicked/
  // bad-credential/connected) via `connect()`'s optional lifecycle hooks —
  // that logic isn't game state, so it stays local component state.
  const status = useGameStore((s) => s.connection);
  const state = useGameStore((s) => s.room);
  const connect = useGameStore((s) => s.connect);
  const disconnect = useGameStore((s) => s.disconnect);
  const send = useGameStore((s) => s.send);

  // Resolve initial auth: dual-credential chooser > session seat/hostKey >
  // host-key recovery offer > seat picker (which offers localStorage
  // backups). This runs once per room code.
  useEffect(() => {
    setPhase({ name: "resolving-auth" });

    const sessionHostKey = getSessionHostKey(code);
    const sessionSeat = getSessionSeat(code);

    // Dual-credential pin: both a hostKey and a seatToken exist for this
    // room (a creator who also joined as a player from the same device) —
    // never auto-pick by storage-read order, always ask.
    if (sessionHostKey && sessionSeat) {
      const backups = getSeatBackups(code);
      const seatName = backups.find((b) => b.seatToken === sessionSeat)?.name ?? "your seat";
      setPhase({
        name: "choosing-identity",
        hostKey: sessionHostKey,
        seatToken: sessionSeat,
        seatName,
      });
      return () => disconnect();
    }

    let auth: Auth | null = null;
    if (sessionHostKey) {
      auth = { kind: "host", hostKey: sessionHostKey };
    } else if (sessionSeat) {
      auth = { kind: "seat", seatToken: sessionSeat };
    }

    if (auth) {
      doConnect(auth);
    } else {
      const hostBackup = getHostKeyBackup(code);
      if (hostBackup) {
        setPhase({ name: "offering-host-recovery", hostKey: hostBackup });
      } else {
        setPhase({ name: "picking-seat" });
      }
    }

    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function doConnect(auth: Auth) {
    connect(code, auth, {
      onWelcome: (info) => {
        if (info.seatToken) {
          setSessionSeat(code, info.seatToken);
          if (auth.kind === "join") {
            appendSeatBackup(code, {
              seatToken: info.seatToken,
              name: auth.name.trim(),
              savedAt: Date.now(),
            });
          }
        }
        if (auth.kind === "host") {
          setSessionHostKey(code, auth.hostKey);
        }
        setPhase({ name: "connected", isHost: info.isHost });
      },
      onKicked: () => setPhase({ name: "kicked" }),
      onBadCredential: () => {
        if (auth.kind === "seat") {
          removeSeatBackup(code, auth.seatToken);
        }
        setPhase({ name: "bad-credential" });
      },
      onError: (err) => setLastError(err),
    });
  }

  function handleJoinAsNew(name: string) {
    doConnect({ kind: "join", name });
  }

  function handlePickBackup(seatToken: string) {
    setSessionSeat(code, seatToken);
    doConnect({ kind: "seat", seatToken });
  }

  function handleChooseHost(hostKey: string) {
    doConnect({ kind: "host", hostKey });
  }

  function handleChoosePlayer(seatToken: string) {
    doConnect({ kind: "seat", seatToken });
  }

  function handleResumeAsHost(hostKey: string) {
    doConnect({ kind: "host", hostKey });
  }

  function handleKick(playerId: string) {
    send({ type: "kick", playerId });
  }

  function handleCopyLink() {
    const url = `${location.origin}/room/${code}`;
    void shareOrCopyLink(url, {
      success: (message) => {
        setManualShareUrl(null);
        toast(message);
      },
      manual: (u) => setManualShareUrl(u),
    });
  }

  function handleStartGame() {
    const seed = testSeedOverride();
    const roleOverride = testRolesOverride();
    const ruleset = roleOverride ? { ...HOUSE_RULESET, roles: { ...HOUSE_RULESET.roles, ...roleOverride } } : HOUSE_RULESET;
    send(
      seed === undefined
        ? { type: "start_game", ruleset }
        : { type: "start_game", ruleset, seed },
    );
  }

  const backups = useMemo(() => getSeatBackups(code), [code, phase.name]);

  if (phase.name === "kicked") {
    return (
      <main className="safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 bg-ink p-6 text-bone">
        <p data-testid="kicked-message" className="text-lg">
          You were removed from this room.
        </p>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="min-h-11 rounded-md bg-blood px-4 py-2 text-bone"
        >
          Back home
        </button>
      </main>
    );
  }

  if (phase.name === "choosing-identity") {
    const { hostKey, seatToken, seatName } = phase;
    return (
      <IdentityChooser
        playerName={seatName}
        onChooseHost={() => handleChooseHost(hostKey)}
        onChoosePlayer={() => handleChoosePlayer(seatToken)}
      />
    );
  }

  if (phase.name === "offering-host-recovery") {
    return (
      <main className="safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 bg-ink p-6 text-bone">
        <h1 className="font-display text-2xl text-blood">Resume hosting?</h1>
        <p className="text-center text-sm text-smoke">
          This browser has a saved host key for room {code}.
        </p>
        <button
          type="button"
          data-testid="resume-as-host"
          onClick={() => handleResumeAsHost(phase.hostKey)}
          className="min-h-11 rounded-md bg-brass px-6 py-3 font-semibold text-ink"
        >
          Resume as host
        </button>
        <button
          type="button"
          data-testid="resume-as-host-decline"
          onClick={() => setPhase({ name: "picking-seat" })}
          className="min-h-11 text-sm text-smoke underline"
        >
          Join as a player instead
        </button>
      </main>
    );
  }

  if (phase.name === "bad-credential" || phase.name === "picking-seat") {
    return (
      <>
        <ConnectionBanner status={status} />
        <SeatPicker
          backups={backups}
          onPickBackup={(entry) => handlePickBackup(entry.seatToken)}
          onJoinAsNew={handleJoinAsNew}
        />
        {lastError && (
          <p data-testid="room-error" className="p-2 text-center text-sm text-blood">
            {lastError.message}
          </p>
        )}
      </>
    );
  }

  if (phase.name === "connected" && state) {
    // The host is a pure arbitrator (decision 2026-07-04) — never a player.
    // Host identity always routes to the dedicated host console screens
    // (Spec 05), never the player-facing Lobby/GameScreen (Spec 04, which
    // this spec must not restyle or touch).
    if (phase.isHost) {
      return (
        <>
          <ConnectionBanner status={status} />
          {state.game === null ? (
            <HostLobby
              state={state}
              onKick={handleKick}
              onCopyLink={handleCopyLink}
              onStartGame={handleStartGame}
            />
          ) : state.game.phase === "ended" ? (
            <HostGameEnd room={state} game={state.game} />
          ) : (
            <HostGame room={state} game={state.game} />
          )}
          <ManualShareLink url={manualShareUrl} onDismiss={() => setManualShareUrl(null)} />
        </>
      );
    }
    return (
      <>
        <ConnectionBanner status={status} />
        {state.game === null ? (
          <Lobby
            state={state}
            isHost={phase.isHost}
            onKick={handleKick}
            onCopyLink={handleCopyLink}
            onStartGame={handleStartGame}
          />
        ) : (
          <GameScreen
            game={state.game}
            players={state.players}
            isHost={phase.isHost}
          />
        )}
        <ManualShareLink url={manualShareUrl} onDismiss={() => setManualShareUrl(null)} />
      </>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink text-bone">
      <p>Connecting…</p>
    </main>
  );
}

/** Last-resort share fallback: when neither the native share sheet nor the
 * clipboard is available (both denied on a locked-down mobile browser), show
 * the room URL in a visible, pre-selected, read-only input so the host can
 * long-press-copy it. This is what makes "Share link" never a dead no-op. */
function ManualShareLink({ url, onDismiss }: { url: string | null; onDismiss: () => void }) {
  if (!url) return null;
  return (
    <div
      data-testid="manual-share-link"
      className="safe-x fixed inset-x-0 bottom-0 z-50 flex flex-col gap-2 border-t border-brass/60 bg-ink-2 p-4 text-bone shadow-lg"
    >
      <p className="text-sm text-bone/80">Copy this link and send it to your friends:</p>
      <input
        data-testid="manual-share-url"
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full select-all rounded-md border border-smoke bg-ink px-3 py-2 text-sm text-brass"
      />
      <button
        type="button"
        data-testid="manual-share-dismiss"
        onClick={onDismiss}
        className="min-h-11 self-end text-sm text-smoke underline"
      >
        Done
      </button>
    </div>
  );
}
