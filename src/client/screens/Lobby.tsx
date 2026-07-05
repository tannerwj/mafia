import type { ClientRoomState } from "../../shared/protocol";
import { Button } from "../components/ui/button";
import HelpButton from "../components/HelpButton";

export default function Lobby({
  state,
  isHost,
  onKick,
  onCopyLink,
  onStartGame,
}: {
  state: ClientRoomState;
  isHost: boolean;
  onKick: (playerId: string) => void;
  onCopyLink: () => void;
  /** Host-only. Deliberately plain/unstyled (Spec 05's job is the real
   * ruleset-configuration host console) — this is the minimum functional
   * trigger needed to start a game at all before that spec ships. */
  onStartGame: () => void;
}) {
  return (
    <main className="safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-md flex-col items-center gap-6 bg-ink p-6 text-bone">
      <div className="flex w-full items-center justify-between gap-2">
        <h1 className="font-display text-3xl text-blood">Lobby</h1>
        <HelpButton />
      </div>

      <div className="flex items-center gap-3">
        <span
          data-testid="room-code"
          className="rounded-md border border-smoke bg-ink-2 px-4 py-2 text-2xl tracking-widest text-brass"
        >
          {state.roomCode}
        </span>
        {isHost && (
          <Button
            type="button"
            data-testid="copy-link"
            onClick={onCopyLink}
            variant="outline"
            size="sm"
          >
            Copy link
          </Button>
        )}
      </div>

      <p className="text-sm text-smoke">
        Host: {state.hostConnected ? "connected" : "not connected"}
      </p>

      <ul className="flex w-full max-w-sm flex-col gap-2" data-testid="player-list">
        {state.players.map((p) => (
          <li
            key={p.id}
            data-testid="player-row"
            data-player-id={p.id}
            data-connected={p.connected}
            className="flex min-h-11 items-center justify-between rounded-md border border-smoke/60 bg-ink-2 px-4 py-2"
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                data-testid="presence-dot"
                className={`inline-block h-2 w-2 rounded-full ${
                  p.connected ? "bg-brass" : "bg-smoke"
                }`}
              />
              {p.name}
              {p.isYou && <span className="text-smoke"> (you)</span>}
            </span>
            {isHost && !p.isYou && (
              <button
                type="button"
                data-testid="kick-button"
                onClick={() => onKick(p.id)}
                className="min-h-11 rounded-md border border-blood px-2 py-1 text-xs text-blood"
              >
                Kick
              </button>
            )}
          </li>
        ))}
        {state.players.length === 0 && (
          <li className="text-center text-smoke">
            Waiting for players to join…
          </li>
        )}
      </ul>

      {isHost && (
        // Functional-ugly on purpose: full ruleset configuration UI is
        // Spec 05's job. This is the minimum host trigger to start a game.
        <button
          type="button"
          data-testid="start-game"
          onClick={onStartGame}
          disabled={state.players.length < 3}
          className="rounded border border-stone-400 bg-stone-800 px-4 py-2 text-stone-100 disabled:opacity-40"
        >
          Start game (house rules)
        </button>
      )}
    </main>
  );
}
