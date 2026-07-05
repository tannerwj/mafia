// Dawn/Dusk announcement interstitials (D2): big serif announcement text
// derived from `log` events. This is display formatting of events the
// engine already emitted — e.g. rendering `attackAttempted{outcome:
// 'failed'}` as "The attack failed" — never a new game concept invented
// client-side.
//
// The log only carries events since the last snapshot the viewer already
// knows about is NOT tracked here (no separate "seen" bookkeeping — that
// would be client-side state drifting from the server). Instead this reads
// the most recent relevant event(s) for the CURRENT day from `game.log`
// every render, which the projection already scopes correctly per-viewer
// (`resolvedLog` in src/engine/project.ts filters hidden-vote events and
// strips `actionSubmitted` for non-god viewers).
import type { ClientGameView, GameEvent } from "../../../shared/game-view";

function playerLabel(playerNames: Map<string, string>, id: string): string {
  return playerNames.get(id) ?? "Someone";
}

function describeDeath(
  event: Extract<GameEvent, { type: "playerDied" }>,
  playerNames: Map<string, string>,
): string {
  const name = playerLabel(playerNames, event.playerId);
  return event.cause === "night"
    ? `${name} was found dead.`
    : `${name} was murdered by the village.`;
}

function describeAttack(
  event: Extract<GameEvent, { type: "attackAttempted" }>,
): string | null {
  // Only the outcome is announced (attacker/defender identities stay
  // private) — matches the spec's exact example: "The attack failed."
  if (event.outcome === "failed") return "The attack failed.";
  return null; // a landed attack is announced via the resulting playerDied event instead
}

function eventsForDay(game: ClientGameView, day: number): GameEvent[] {
  return game.log.filter((e) => {
    if (e.type === "playerDied") return e.day === day;
    if (e.type === "attackAttempted") return e.day === day;
    if (e.type === "voteResolved") return e.day === day;
    if (e.type === "runoffStarted") return e.day === day;
    return false;
  });
}

function announcementsFor(
  game: ClientGameView,
  playerNames: Map<string, string>,
): string[] {
  const events = eventsForDay(game, game.day);
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "attackAttempted") {
      const line = describeAttack(event);
      if (line) lines.push(line);
    } else if (event.type === "playerDied") {
      lines.push(describeDeath(event, playerNames));
    } else if (event.type === "voteResolved") {
      lines.push(
        event.eliminatedId
          ? `${playerLabel(playerNames, event.eliminatedId)} was voted out.`
          : "The village chose not to murder anyone.",
      );
    } else if (event.type === "runoffStarted") {
      lines.push("The vote is tied — a runoff begins.");
    }
  }
  return lines;
}

export default function Interstitial({
  game,
  playerNames,
}: {
  game: ClientGameView;
  playerNames: Map<string, string>;
}) {
  const isDawn = game.phase === "dawn";
  const lines = announcementsFor(game, playerNames);
  const heading = isDawn ? "Dawn breaks" : "Night falls";
  const fallback = isDawn
    ? "The village wakes to a quiet night."
    : "The village settles in for the night.";

  return (
    <div
      data-testid="interstitial"
      data-phase={game.phase}
      className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <p className="text-xs uppercase tracking-[0.3em] text-smoke">
        Day {game.day}
      </p>
      <h1 className="font-display text-4xl text-bone">{heading}</h1>
      <div data-testid="interstitial-lines" className="flex flex-col gap-2">
        {lines.length === 0 ? (
          <p className="text-lg text-bone/80">{fallback}</p>
        ) : (
          lines.map((line, i) => (
            <p key={i} className="text-lg text-bone/80">
              {line}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
