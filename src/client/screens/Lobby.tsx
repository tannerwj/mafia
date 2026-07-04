import type { ClientRoomState } from "../../shared/protocol";

export default function Lobby({
  state,
  isHost,
  onKick,
  onCopyLink,
}: {
  state: ClientRoomState;
  isHost: boolean;
  onKick: (playerId: string) => void;
  onCopyLink: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center gap-6 bg-stone-950 p-6 text-stone-100">
      <h1 className="font-serif text-3xl text-red-800">Lobby</h1>

      <div className="flex items-center gap-3">
        <span
          data-testid="room-code"
          className="rounded bg-stone-800 px-4 py-2 text-2xl tracking-widest"
        >
          {state.roomCode}
        </span>
        {isHost && (
          <button
            type="button"
            data-testid="copy-link"
            onClick={onCopyLink}
            className="rounded border border-stone-600 px-3 py-2 text-sm"
          >
            Copy link
          </button>
        )}
      </div>

      <p className="text-sm text-stone-400">
        Host: {state.hostConnected ? "connected" : "not connected"}
      </p>

      <ul className="flex w-full max-w-sm flex-col gap-2" data-testid="player-list">
        {state.players.map((p) => (
          <li
            key={p.id}
            data-testid="player-row"
            data-player-id={p.id}
            data-connected={p.connected}
            className="flex items-center justify-between rounded bg-stone-900 px-4 py-2"
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                data-testid="presence-dot"
                className={`inline-block h-2 w-2 rounded-full ${
                  p.connected ? "bg-green-500" : "bg-stone-600"
                }`}
              />
              {p.name}
              {p.isYou && <span className="text-stone-400"> (you)</span>}
            </span>
            {isHost && !p.isYou && (
              <button
                type="button"
                data-testid="kick-button"
                onClick={() => onKick(p.id)}
                className="rounded border border-red-800 px-2 py-1 text-xs text-red-400"
              >
                Kick
              </button>
            )}
          </li>
        ))}
        {state.players.length === 0 && (
          <li className="text-center text-stone-500">
            Waiting for players to join…
          </li>
        )}
      </ul>
    </main>
  );
}
