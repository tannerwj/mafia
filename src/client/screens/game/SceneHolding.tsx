// Spec 12 Feature 2: the player-facing "narrator is setting the scene" holding
// screen, shown during `sunrise`/`sunset`. This is a LEAK SURFACE by design:
// because the night/day is genuinely UNRESOLVED at this point (the engine
// deferred resolveNight/resolveVote to the host's Reveal tap), the projection
// carries NO outcome — nobody has died, no playerDied is in the log yet. This
// component therefore shows NOTHING about what's coming: no names, no counts,
// no "someone died" hint — only a neutral waiting message. It reads nothing
// from `game` beyond the phase, deliberately.
import type { ClientGameView } from "../../../shared/game-view";

export default function SceneHolding({ game }: { game: ClientGameView }) {
  const isSunrise = game.phase === "sunrise";
  const heading = isSunrise ? "Setting the morning scene" : "Setting the evening scene";
  return (
    <div
      data-testid="scene-holding"
      data-phase={game.phase}
      className="animate-rise flex min-h-[calc(100dvh-9rem)] flex-1 flex-col items-center justify-center gap-5 px-6 pb-8 pt-3"
      aria-live="polite"
    >
      <div className="file-torn relative w-full max-w-sm rounded-sm border border-frame bg-ink-2 p-6 text-center shadow-card">
        <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">
          {isSunrise ? "Before dawn" : "Before nightfall"} · File Day {game.day}
        </p>
        <h1 className="file-heading mt-2 text-3xl leading-none text-bone">
          {heading}
        </h1>
        <p className="mt-2 text-sm text-brass-hi">Listen for the host's reveal.</p>
        <div className="mx-auto my-4 h-px w-16 bg-frame" />
        <p className="text-base text-paper/80">
          <span aria-hidden className="mr-1 select-none text-smoke">
            //
          </span>
          The narrator is setting the scene. Sit tight — the story continues in a moment.
        </p>
        <p className="mt-4 text-sm text-smoke">
          Waiting for the narrator to finish…
        </p>
      </div>
    </div>
  );
}
