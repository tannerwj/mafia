// Dead god view (D2): "you are dead" banner + full roles list + resolved
// history. The projection already grants god visibility (every player's
// roleId, resolved votes) to a dead viewer via `project.ts`'s `god` flag —
// the UI renders exactly that and nothing more. No pending-submission data
// is shown for a dead viewer (there is none in `you.*` for a dead player —
// the projection itself omits it, so there's nothing to accidentally
// invent placeholders for).
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientPlayerView } from "../../../shared/protocol";
import { roleCopyFor } from "../../lib/roleCopy";
import { Stamp } from "../../components/ui/dossier";

export default function DeadGodView({
  game,
  players,
}: {
  game: ClientGameView;
  players: ClientPlayerView[];
}) {
  const playerNames = new Map(players.map((p) => [p.id, p.name]));

  return (
    <div data-testid="dead-god-view" className="animate-rise flex flex-col gap-6 px-4 py-6">
      <div className="relative overflow-hidden rounded-sm border border-blood/60 bg-ink-2 px-4 pb-6 pt-12 text-center shadow-card">
        <Stamp variant="deceased" decorative className="absolute left-1/2 top-4 -translate-x-1/2 text-sm" />
        <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">
          Subject removed from play
        </p>
        <p className="file-heading mt-1 text-3xl text-blood">You are deceased</p>
        <p className="mt-2 text-sm text-smoke">
          // the full file is now open to you. Watch it close.
        </p>
      </div>

      <div>
        <p className="mb-2 text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
          The unsealed file — every subject
        </p>
        <ul className="flex flex-col gap-2" data-testid="dead-god-roles">
          {game.players.map((p) => {
            const copy = p.roleId ? roleCopyFor(p.roleId) : null;
            return (
              <li
                key={p.id}
                data-testid="dead-god-role-row"
                data-player-id={p.id}
                className={`flex items-center justify-between rounded-sm border px-4 py-2 ${
                  p.alive ? "border-frame bg-ink-2" : "border-frame/50 bg-ink-3 opacity-70"
                }`}
              >
                <span className={p.alive ? "text-paper" : "text-smoke line-through"}>
                  {playerNames.get(p.id) ?? p.id}
                </span>
                <span className={p.alive ? "text-paper" : "text-smoke"}>
                  {copy?.displayName ?? "Unknown"}
                  {!p.alive && " · deceased"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <p className="mb-2 text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
          Case log
        </p>
        <ResolvedHistory game={game} playerNames={playerNames} />
      </div>
    </div>
  );
}

function ResolvedHistory({
  game,
  playerNames,
}: {
  game: ClientGameView;
  playerNames: Map<string, string>;
}) {
  const lines: string[] = [];
  for (const event of game.log) {
    if (event.type === "playerDied") {
      const name = playerNames.get(event.playerId) ?? "Someone";
      lines.push(
        event.cause === "night"
          ? `Night ${event.day}: ${name} was found dead.`
          : `Day ${event.day}: ${name} was murdered by vote.`,
      );
    } else if (event.type === "voteResolved" && !event.eliminatedId) {
      // When `eliminatedId` is set, `killByVote` already logged a
      // `playerDied{cause:"vote"}` for this exact elimination (rendered
      // above) — rendering this event too would double-report the same
      // death. Only the no-one-eliminated case (tie/no_murder/peace) needs
      // its own line here.
      lines.push(
        event.reason === "no_murder"
          ? `Day ${event.day}: the town spared everyone.`
          : `Day ${event.day}: no one was voted out.`,
      );
    } else if (event.type === "gameEnded") {
      lines.push(`The game ended: ${event.winners.join(", ")} win.`);
    }
  }

  if (lines.length === 0) {
    return <p className="text-sm text-smoke">Nothing resolved yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-1 text-sm text-bone/80" data-testid="dead-god-history">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}
