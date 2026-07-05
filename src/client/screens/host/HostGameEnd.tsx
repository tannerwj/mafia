// HostGameEnd (D1): result + full reveal recap + "Start rematch" -> new_game.
// `new_game` is one of the two dangerous controls that confirm once (D1
// pin) — its consequence is "everyone returns to the lobby, seats kept."
import { useState } from "react";
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientRoomState } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import ConfirmDialog from "../../components/ConfirmDialog";
import { roleCopyFor } from "../../lib/roleCopy";
import { newGame } from "../../store/gameStore";
import PrivacyChip from "./PrivacyChip";
import HostLog from "./HostLog";

function winnerLabel(winners: string[]): string {
  if (winners.includes("village")) return "The village wins";
  if (winners.includes("mafia")) return "The mafia wins";
  if (winners.includes("suicide_bomber")) return "The suicide bomber wins";
  return winners.length > 0 ? `${winners.join(", ")} win` : "Game over";
}

export default function HostGameEnd({ room, game }: { room: ClientRoomState; game: ClientGameView }) {
  const playerNames = new Map(room.players.map((p) => [p.id, p.name]));
  const winners = game.winners ?? [];
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <main className="safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 bg-ink p-6 text-bone">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-2xl text-blood">Host console</h1>
        <PrivacyChip />
      </div>

      <div className="text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-smoke">Game over</p>
        <h2 className="font-display text-4xl text-brass" data-testid="host-winner-splash">
          {winnerLabel(winners)}
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ul className="flex flex-col gap-2" data-testid="host-final-roles">
          {game.players.map((p) => {
            const copy = p.roleId ? roleCopyFor(p.roleId) : null;
            return (
              <li
                key={p.id}
                data-testid="host-final-role-row"
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

        <HostLog game={game} playerNames={playerNames} />
      </div>

      <Button
        type="button"
        data-testid="new-game"
        variant="brass"
        size="lg"
        onClick={() => setConfirmOpen(true)}
        className="w-full"
      >
        Start rematch
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        testId="new-game-confirm"
        title="Start a rematch?"
        description="Everyone returns to the lobby with their seats kept. You'll configure and start the next game from there."
        confirmLabel="Start rematch"
        onConfirm={() => newGame()}
      />
    </main>
  );
}
