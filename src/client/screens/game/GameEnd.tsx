// GameEnd (D2): winner splash in brass, full role reveal table, "waiting
// for host" state (only the host can start a new game — `new_game` is
// host-only per protocol.ts — so a player simply waits here).
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientPlayerView } from "../../../shared/protocol";
import { roleCopyFor } from "../../lib/roleCopy";
import { newGame } from "../../store/gameStore";

function winnerLabel(winners: string[]): string {
  if (winners.includes("village")) return "The village wins";
  if (winners.includes("mafia")) return "The mafia wins";
  if (winners.includes("suicide_bomber")) return "The suicide bomber wins";
  return winners.length > 0 ? `${winners.join(", ")} win` : "Game over";
}

export default function GameEnd({
  game,
  players,
  isHost,
}: {
  game: ClientGameView;
  players: ClientPlayerView[];
  isHost: boolean;
}) {
  const playerNames = new Map(players.map((p) => [p.id, p.name]));
  const winners = game.winners ?? [];

  return (
    <div data-testid="game-end" className="flex flex-col gap-6 px-4 py-8 text-center">
      <div>
        <p className="text-xs uppercase tracking-[0.3em] text-smoke">
          Game over
        </p>
        <h1 className="font-display text-4xl text-brass" data-testid="winner-splash">
          {winnerLabel(winners)}
        </h1>
      </div>

      <ul className="flex flex-col gap-2 text-left" data-testid="final-roles">
        {game.players.map((p) => {
          const copy = p.roleId ? roleCopyFor(p.roleId) : null;
          return (
            <li
              key={p.id}
              data-testid="final-role-row"
              data-player-id={p.id}
              className={`flex items-center justify-between rounded-md border px-4 py-2 ${
                p.alive ? "border-brass/50 bg-ink-2" : "border-smoke/30 bg-ink-3 opacity-70"
              }`}
            >
              <span>{playerNames.get(p.id) ?? p.id}</span>
              <span>{copy?.displayName ?? "Unknown"}</span>
            </li>
          );
        })}
      </ul>

      {isHost ? (
        // Functional-ugly on purpose (Spec 05's job to style the host
        // console) — the minimum trigger to let the host loop back to lobby.
        <button
          type="button"
          data-testid="new-game"
          onClick={() => newGame()}
          className="rounded border border-stone-400 bg-stone-800 px-4 py-2 text-stone-100"
        >
          New game
        </button>
      ) : (
        <p data-testid="waiting-for-host" className="text-sm text-smoke">
          Waiting for the host to start a new game…
        </p>
      )}
    </div>
  );
}
