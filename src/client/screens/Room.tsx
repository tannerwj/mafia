import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientRoomState, ErrorMessage } from "../../shared/protocol";
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
import type { Auth, ConnectionStatus } from "../net/RoomConnection";
import { RoomConnection } from "../net/RoomConnection";
import { navigate } from "../useRoute";
import ConnectionBanner from "./ConnectionBanner";
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
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [state, setState] = useState<ClientRoomState | null>(null);
  const [lastError, setLastError] = useState<ErrorMessage | null>(null);
  const connectionRef = useRef<RoomConnection | null>(null);

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
      connect(auth);
    } else {
      setPhase({ name: "picking-seat" });
    }

    return () => {
      connectionRef.current?.close();
      connectionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function connect(auth: Auth) {
    connectionRef.current?.close();
    const conn = new RoomConnection(code, auth, {
      onStatusChange: setStatus,
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
        setState(info.state);
        setPhase({ name: "connected", isHost: info.isHost });
      },
      onSnapshot: setState,
      onKicked: () => {
        setPhase({ name: "kicked" });
      },
      onBadCredential: () => {
        if (auth.kind === "seat") {
          removeSeatBackup(code, auth.seatToken);
        }
        setPhase({ name: "bad-credential" });
      },
      onError: (err) => setLastError(err),
    });
    connectionRef.current = conn;
  }

  function handleJoinAsNew(name: string) {
    connect({ kind: "join", name });
  }

  function handlePickBackup(seatToken: string) {
    setSessionSeat(code, seatToken);
    connect({ kind: "seat", seatToken });
  }

  function handleKick(playerId: string) {
    connectionRef.current?.send({ type: "kick", playerId });
  }

  function handleCopyLink() {
    const url = `${location.origin}/room/${code}`;
    void navigator.clipboard?.writeText(url);
  }

  const backups = useMemo(() => getSeatBackups(code), [code, phase.name]);

  if (phase.name === "kicked") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-stone-950 p-6 text-stone-100">
        <p data-testid="kicked-message" className="text-lg">
          You were removed from this room.
        </p>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded bg-red-800 px-4 py-2 text-stone-50"
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
          <p data-testid="room-error" className="p-2 text-center text-sm text-red-400">
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
        <Lobby
          state={state}
          isHost={phase.isHost}
          onKick={handleKick}
          onCopyLink={handleCopyLink}
        />
      </>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-stone-950 text-stone-100">
      <p>Connecting…</p>
    </main>
  );
}
