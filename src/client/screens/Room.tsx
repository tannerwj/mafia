import { useEffect, useMemo, useState } from "react";
import type { ErrorMessage } from "../../shared/protocol";
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
import Lobby from "./Lobby";
import SeatPicker from "./SeatPicker";

type Phase =
  | { name: "resolving-auth" }
  | { name: "picking-seat" }
  | { name: "connected"; isHost: boolean }
  | { name: "kicked" }
  | { name: "bad-credential" };

export default function Room({ code }: { code: string }) {
  const [phase, setPhase] = useState<Phase>({ name: "resolving-auth" });
  const [lastError, setLastError] = useState<ErrorMessage | null>(null);

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

  // Resolve initial auth: session seat/hostKey > nothing (seat picker offers
  // localStorage backups). This runs once per room code.
  useEffect(() => {
    setPhase({ name: "resolving-auth" });

    const sessionHostKey = getSessionHostKey(code);
    const sessionSeat = getSessionSeat(code);

    let auth: Auth | null = null;
    if (sessionHostKey) {
      auth = { kind: "host", hostKey: sessionHostKey };
    } else if (sessionSeat) {
      auth = { kind: "seat", seatToken: sessionSeat };
    } else {
      const hostBackup = getHostKeyBackup(code);
      if (hostBackup) {
        auth = { kind: "host", hostKey: hostBackup };
      }
    }

    if (auth) {
      doConnect(auth);
    } else {
      setPhase({ name: "picking-seat" });
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

  function handleKick(playerId: string) {
    send({ type: "kick", playerId });
  }

  function handleCopyLink() {
    const url = `${location.origin}/room/${code}`;
    void navigator.clipboard?.writeText(url);
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
      </>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink text-bone">
      <p>Connecting…</p>
    </main>
  );
}
