// Dawn/Dusk announcement interstitials (D2): big serif announcement text.
// Resolved deaths come from the projection's graveyard, while the failed
// attack aggregate and public vote events preserve the table-facing wording
// without exposing actor/target details through `game.log`.
import type { ClientGameView } from "../../../shared/game-view";
import { acknowledge } from "../../store/gameStore";

function playerLabel(playerNames: Map<string, string>, id: string): string {
  return playerNames.get(id) ?? "Someone";
}

function describeDeath(
  death: ClientGameView["graveyard"][number],
  playerNames: Map<string, string>,
): string {
  const name = playerLabel(playerNames, death.playerId);
  return death.cause === "night"
    ? `${name} was found dead.`
    : `${name} was murdered by the village.`;
}

function publicOutcomeEventsForDay(game: ClientGameView, day: number) {
  return game.log.filter((e) => {
    if (e.type === "voteResolved") return e.day === day;
    if (e.type === "runoffStarted") return e.day === day;
    return false;
  });
}

function announcementsFor(
  game: ClientGameView,
  playerNames: Map<string, string>,
): string[] {
  const lines: string[] = [];
  if (game.attackFailedDays.includes(game.day)) lines.push("The attack failed.");

  // Graveyard is the single source for death announcements. A full-reveal
  // compatibility `playerDied` event may also be present in the safe log, so
  // intentionally do not render deaths from the log.
  for (const death of game.graveyard.filter((entry) => entry.day === game.day)) {
    lines.push(describeDeath(death, playerNames));
  }

  for (const event of publicOutcomeEventsForDay(game, game.day)) {
    if (event.type === "voteResolved") {
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
  const heading = isDawn ? "Morning bulletin" : "Evening dispatch";
  const fallback = isDawn
    ? "The night passed — no one died."
    : "The town settles in for the night.";

  // Spec 11 Feature 3: dawn is a Morning Report every living player must
  // acknowledge (Continue). The phase advances on all-ack OR the beat backstop
  // OR host force — so it can't hang but everyone can read it. `acknowledge`
  // carries `phaseGen`; a stale ack (phase already advanced) no-ops
  // server-side. Dusk stays a passive auto-advancing announcement this round.
  const you = game.you;
  const acked = you?.acknowledged ?? false;

  return (
    <div
      data-testid="interstitial"
      data-phase={game.phase}
      className="animate-rise flex min-h-[calc(100dvh-9rem)] flex-1 flex-col items-center justify-center gap-5 px-6 pb-8 pt-3"
      aria-live="polite"
    >
      {/* A typed case bulletin on a torn sheet. The torn top edge is a
          decorative pseudo-layer (pointer-events:none via .file-torn). */}
      <div
        data-testid={isDawn ? "morning-report" : undefined}
        className="file-torn relative w-full max-w-sm rounded-sm border border-frame bg-ink-2 p-6 text-center shadow-card"
      >
        <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">
          {isDawn ? "Dawn report" : "Nightfall report"} · File Day {game.day}
        </p>
        <h1 className="file-heading mt-2 text-3xl leading-none text-bone">
          {heading}
        </h1>
        <p className="mt-2 text-sm text-paper/80">
          {isDawn ? (acked ? "Your report is filed." : "Read this report, then acknowledge it.") : "Stay with the table while the host closes the scene."}
        </p>
        <div className="mx-auto my-4 h-px w-16 bg-frame" />
        <div data-testid="interstitial-lines" className="flex flex-col gap-2">
          {lines.length === 0 ? (
            <p className="text-base text-paper/80">
              <span aria-hidden className="mr-1 select-none text-smoke">
                //
              </span>
              {fallback}
            </p>
          ) : (
            lines.map((line, i) => (
              <p key={i} className="text-base text-paper/80">
                {line}
              </p>
            ))
          )}
        </div>

        {isDawn &&
          (acked ? (
            <p className="mt-6 text-sm text-smoke">
              // waiting for the rest of the room…
            </p>
          ) : (
            <button
              type="button"
              data-testid="acknowledge-button"
              onClick={() => acknowledge(game.phaseGen)}
              className="mt-6 min-h-11 w-full rounded-sm border-2 border-brass bg-ink-3 px-4 py-3 text-sm font-bold uppercase tracking-[0.1em] text-brass-hi transition-colors"
            >
              Continue
            </button>
          ))}
      </div>
    </div>
  );
}
