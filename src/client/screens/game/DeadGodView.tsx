// Dead god view (D2): "you are dead" banner + full roles list + resolved
// history. The projection grants roles and resolved outcomes to a dead viewer
// while withholding live submissions and hidden ballots. Death history comes
// from the graveyard so it works for every reveal mode and never duplicates a
// compatibility `playerDied` event in the safe log.
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
    <div
      data-testid="dead-god-view"
      className="animate-rise flex min-h-[calc(100dvh-9rem)] flex-col gap-6 px-4 pb-8 pt-3"
    >
      <div className="relative overflow-hidden rounded-sm border border-blood/60 bg-ink-2 px-4 pb-6 pt-12 text-center shadow-card">
        <Stamp variant="deceased" decorative className="absolute left-1/2 top-4 -translate-x-1/2 text-sm" />
        <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">
          Subject removed from play
        </p>
        <p className="file-heading mt-1 text-3xl text-blood-hi">You are deceased</p>
        <p className="mt-2 text-sm text-smoke">
          // you are out of play. The resolved file is now open to you.
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
            The unsealed file — every subject
          </p>
          <span className="shrink-0 text-xs tabular-nums text-smoke">{game.headcount.alive} alive</span>
        </div>
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
  // The raw resolved log is the sequence authority. Merge graveyard entries
  // at their corresponding playerDied event instead of rendering every death
  // first; that keeps a day/night death beside the vote or runoff that
  // produced it. The fallback handles older snapshots with a graveyard entry
  // but no matching compatibility event and orders it by day afterward.
  const deathByPlayerId = new Map(game.graveyard.map((death) => [death.playerId, death]));
  const renderedDeaths = new Set<string>();
  const lines: { day: number; sequence: number; text: string }[] = [];

  for (const [sequence, event] of game.log.entries()) {
    if (event.type === "playerDied") {
      const death = deathByPlayerId.get(event.playerId);
      if (death) {
        const name = playerNames.get(death.playerId) ?? "Someone";
        lines.push({
          day: death.day,
          sequence,
          text: death.cause === "night"
            ? `Night ${death.day}: ${name} was found dead.`
            : `Day ${death.day}: ${name} was murdered by vote.`,
        });
        renderedDeaths.add(death.playerId);
      }
    } else if (event.type === "voteResolved" && !event.eliminatedId) {
      // When `eliminatedId` is set, `killByVote` already logged a
      // `playerDied{cause:"vote"}` for this exact elimination (rendered
      // above) — rendering this event too would double-report the same
      // death. Only the no-one-eliminated case (tie/no_murder/peace) needs
      // its own line here.
      lines.push({
        day: event.day,
        sequence,
        text: event.reason === "no_murder"
          ? `Day ${event.day}: the town spared everyone.`
          : `Day ${event.day}: no one was voted out.`,
      });
    } else if (event.type === "runoffStarted") {
      lines.push({ day: event.day, sequence, text: `Day ${event.day}: the vote went to a runoff.` });
    } else if (event.type === "gameEnded") {
      lines.push({ day: Number.POSITIVE_INFINITY, sequence, text: `The game ended: ${event.winners.join(", ")} win.` });
    }
  }

  for (const [sequence, death] of game.graveyard.entries()) {
    if (renderedDeaths.has(death.playerId)) continue;
    const name = playerNames.get(death.playerId) ?? "Someone";
    lines.push({
      day: death.day,
      sequence: game.log.length + sequence,
      text: death.cause === "night"
        ? `Night ${death.day}: ${name} was found dead.`
        : `Day ${death.day}: ${name} was murdered by vote.`,
    });
  }

  lines.sort((a, b) => a.day - b.day || a.sequence - b.sequence);

  if (lines.length === 0) {
    return <p className="text-sm text-smoke">Nothing resolved yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-1 text-sm text-bone/80" data-testid="dead-god-history">
          {lines.map((line, i) => (
        <li key={i}>{line.text}</li>
      ))}
    </ul>
  );
}
