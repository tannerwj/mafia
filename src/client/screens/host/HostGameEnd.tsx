// HostGameEnd (D1): result + full reveal recap + "Start rematch" -> new_game.
// `new_game` is one of the two dangerous controls that confirm once (D1
// pin) — its consequence is "everyone returns to the lobby, seats kept."
import { useState } from "react";
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientRoomState } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import ConfirmDialog from "../../components/ConfirmDialog";
import { Stamp } from "../../components/ui/dossier";
import { roleCopyFor } from "../../lib/roleCopy";
import { newGame } from "../../store/gameStore";
import PrivacyChip from "./PrivacyChip";
import HostLog from "./HostLog";
import { StorytellerPanel } from "./Storyteller";

// Verdict copy — the winner substrings the E2E asserts on in
// host-winner-splash ("village"/"mafia") are preserved exactly.
function winnerLabel(winners: string[]): string {
  if (winners.includes("village")) return "Verdict: the village prevails";
  if (winners.includes("mafia")) return "Verdict: the mafia prevails";
  if (winners.includes("suicide_bomber")) return "Verdict: the suicide bomber wins alone";
  return winners.length > 0 ? `Verdict: ${winners.join(", ")} win` : "Case closed";
}

export default function HostGameEnd({ room, game }: { room: ClientRoomState; game: ClientGameView }) {
  const playerNames = new Map(room.players.map((p) => [p.id, p.name]));
  const winners = game.winners ?? [];
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <main className="page-p relative z-10 mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 bg-ink text-paper">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <p className="text-[0.6rem] uppercase tracking-[0.3em] text-smoke">
            Lead investigator
          </p>
          <h1 className="file-heading text-xl text-blood">The Case Board</h1>
        </div>
        <PrivacyChip />
      </div>

      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <Stamp variant="case-closed" className="text-sm" />
        <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">File closed</p>
        <h2
          className="file-heading text-3xl leading-none text-brass-hi"
          data-testid="host-winner-splash"
        >
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

        <div className="flex flex-col gap-4">
          <StorytellerPanel story={room.story} legalBeat="epilogue" phaseGen={game.phaseGen} />
          <HostLog game={game} playerNames={playerNames} />
        </div>
      </div>

      <Button
        type="button"
        data-testid="new-game"
        variant="brass"
        size="lg"
        onClick={() => setConfirmOpen(true)}
        className="w-full"
      >
        Open a new case
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
