// Spec 12 Feature 1: the narrator vote/status board — HOST-ONLY (god view).
// Per day/night, it shows the locked picture (who voted/acted for whom) plus
// who still hasn't locked, for BOTH day votes and night role actions, with
// per-day history navigation.
//
// History is RECONSTRUCTED client-side from the host projection's log via
// `narratorBoardHistory` (locked-event replay) — NOT from retained raw state,
// and NOT via a new projection variant. "Locked only" falls out because the
// helper keys off `*Locked` events. This file lives under screens/host/** and
// is imported ONLY by the host console — it must never touch a player path.
//
// Stragglers ("who hasn't locked") for the CURRENT phase come from the live
// host projection: `players[].acted === false` at night (host-only field), and
// living players without a locked vote by day. Past days show locked rows only
// (their stragglers are historical noise once the phase resolved).
import { useEffect, useState } from "react";
import type { ClientGameView } from "../../../shared/game-view";
import { narratorBoardHistory, type NarratorBoardDay } from "../../../engine";
import type { HostSeatRow } from "../../store/hostView";

// The reconstructed history carries `actionType` as a plain string (log
// replay), so this maps loosely and falls back to the raw type.
function actionLabel(type: string): string {
  const labels: Record<string, string> = {
    mafiaKill: "kill",
    protect: "protect",
    investigate: "investigate",
    roleblock: "roleblock",
    kill: "kill",
    watch: "watch",
  };
  return labels[type] ?? type;
}

export default function NarratorBoard({
  game,
  rows,
  playerNames,
}: {
  game: ClientGameView;
  rows: HostSeatRow[];
  playerNames: Map<string, string>;
}) {
  const history: NarratorBoardDay[] = narratorBoardHistory(game.log);
  const name = (id: string) => playerNames.get(id) ?? id;
  const currentDay = game.day;

  // Default the navigator to the current day; follow it forward as the game
  // advances, but leave the host free to browse back into history.
  const [viewDay, setViewDay] = useState(currentDay);
  useEffect(() => {
    setViewDay(currentDay);
  }, [currentDay]);

  const days = history.length > 0 ? history.map((h) => h.day) : [currentDay];
  const minDay = Math.min(...days, currentDay);
  const maxDay = Math.max(...days, currentDay);
  const clamped = Math.min(Math.max(viewDay, minDay), maxDay);
  const dayData = history.find((h) => h.day === clamped);

  const isCurrent = clamped === currentDay;
  const nightPhaseNow = game.phase === "night" || game.phase === "sunrise";
  const dayPhaseNow = game.phase === "day" || game.phase === "runoff" || game.phase === "sunset";

  // Current-phase stragglers, host-only live signals.
  const living = rows.filter((r) => r.alive && !r.absent);
  const nightStragglers =
    isCurrent && nightPhaseNow
      ? living.filter((r) => game.players.find((p) => p.id === r.id)?.acted === false).map((r) => r.id)
      : [];
  const lockedVoters = new Set((dayData?.dayVotes ?? []).map((v) => v.voterId));
  const dayStragglers =
    isCurrent && dayPhaseNow ? living.filter((r) => !lockedVoters.has(r.id)).map((r) => r.id) : [];

  const nightRows = dayData?.nightActions ?? [];
  const voteRows = dayData?.dayVotes ?? [];

  return (
    <div data-testid="narrator-vote-board" className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">Narrator board</p>
        <div data-testid="board-phase-nav" className="flex items-center gap-2">
          <button
            type="button"
            data-testid="board-nav-prev"
            aria-label="Previous day"
            disabled={clamped <= minDay}
            onClick={() => setViewDay(clamped - 1)}
            className="flex h-11 w-11 items-center justify-center rounded-sm border border-frame text-lg text-paper disabled:opacity-40"
          >
            ‹
          </button>
          <span className="w-24 text-center text-sm tabular-nums text-brass-hi">
            Day {clamped}
            {isCurrent && <span className="ml-1 text-[0.6rem] uppercase text-smoke">now</span>}
          </span>
          <button
            type="button"
            data-testid="board-nav-next"
            aria-label="Next day"
            disabled={clamped >= maxDay}
            onClick={() => setViewDay(clamped + 1)}
            className="flex h-11 w-11 items-center justify-center rounded-sm border border-frame text-lg text-paper disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-sm border border-frame bg-ink-3 p-3">
        <section>
          <p className="mb-1 text-[0.6rem] uppercase tracking-[0.15em] text-smoke">
            Night {clamped} — locked actions
          </p>
          {nightRows.length === 0 ? (
            <p className="text-sm text-smoke">// nothing locked yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {nightRows.map((a) => (
                <li
                  key={a.actorId}
                  data-testid="board-night-row"
                  data-actor-id={a.actorId}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="text-paper">{name(a.actorId)}</span>
                  <span className="text-paper/80">
                    {actionLabel(a.actionType)}
                    {a.targetId ? ` → ${name(a.targetId)}` : " → —"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {nightStragglers.length > 0 && (
            <p data-testid="board-night-stragglers" className="mt-1 text-xs text-blood">
              Not locked: {nightStragglers.map(name).join(", ")}
            </p>
          )}
        </section>

        <section>
          <p className="mb-1 text-[0.6rem] uppercase tracking-[0.15em] text-smoke">
            Day {clamped} — locked votes
          </p>
          {voteRows.length === 0 ? (
            <p className="text-sm text-smoke">// nothing locked yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {voteRows.map((v) => (
                <li
                  key={v.voterId}
                  data-testid="board-vote-row"
                  data-voter-id={v.voterId}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="text-paper">{name(v.voterId)}</span>
                  <span className="text-paper/80">
                    {v.target === "no_murder" ? "no murder" : v.target ? name(v.target) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {dayStragglers.length > 0 && (
            <p data-testid="board-day-stragglers" className="mt-1 text-xs text-blood">
              Not locked: {dayStragglers.map(name).join(", ")}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
