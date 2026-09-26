// GameEnd (D2): winner splash in brass, full role reveal table, "waiting
// for host" state (only the host can start a new game — `new_game` is
// host-only per protocol.ts — so a player simply waits here).
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientPlayerView } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import { Stamp } from "../../components/ui/dossier";
import { roleCopyFor } from "../../lib/roleCopy";
import { newGame } from "../../store/gameStore";

// Verdict copy — the winner substrings ("village"/"mafia"/"bomber") the E2E
// asserts on in winner-splash are preserved exactly inside these lines.
function winnerLabel(winners: string[]): string {
  if (winners.includes("village")) return "Verdict: the village prevails";
  if (winners.includes("mafia")) return "Verdict: the mafia prevails";
  if (winners.includes("suicide_bomber")) return "Verdict: the suicide bomber wins alone";
  return winners.length > 0 ? `Verdict: ${winners.join(", ")} win` : "Case closed";
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
    <div
      data-testid="game-end"
      className="animate-rise flex min-h-[calc(100dvh-9rem)] flex-col gap-6 px-4 pb-8 pt-3 text-center"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3 py-2">
        <Stamp variant="case-closed" className="text-sm" />
        <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">
          File closed
        </p>
        <h1
          className="file-heading text-3xl leading-none text-brass-hi"
          data-testid="winner-splash"
        >
          {winnerLabel(winners)}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-paper/80">
          The table is resolved. Review every assignment before deciding whether to rematch.
        </p>
      </div>

      <div>
        <p className="mb-2 text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
          The unsealed file
        </p>
        <ul className="flex flex-col gap-2 text-left" data-testid="final-roles">
          {game.players.map((p) => {
            const copy = p.roleId ? roleCopyFor(p.roleId) : null;
            return (
              <li
                key={p.id}
                data-testid="final-role-row"
                data-player-id={p.id}
                className={`flex items-center justify-between rounded-sm border px-4 py-2 ${
                  p.alive ? "border-brass/50 bg-ink-2" : "border-frame/50 bg-ink-3 opacity-70"
                }`}
              >
                <span className={p.alive ? "text-paper" : "text-smoke line-through"}>
                  {playerNames.get(p.id) ?? p.id}
                </span>
                <span>{copy?.displayName ?? "Unknown"}</span>
              </li>
            );
          })}
        </ul>
      </div>

      {isHost ? (
        <Button
          type="button"
          data-testid="new-game"
          variant="brass"
          size="lg"
          onClick={() => newGame()}
          className="w-full max-w-sm self-center"
        >
          Open a new case
        </Button>
      ) : (
        <p data-testid="waiting-for-host" className="mt-auto text-sm text-smoke">
          // awaiting the investigator to open a new case. Stay at the table.
        </p>
      )}
    </div>
  );
}
