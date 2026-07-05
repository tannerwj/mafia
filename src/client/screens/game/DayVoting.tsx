// Day+Voting (D2): grid of living players + `no_murder` card styled
// distinctly ("Spare the town"), current-vote highlight, change-vote (no
// confirm-lock — always changeable until dusk per the spec's pinned
// convention), hidden-mode shows "N of M have voted" from `voted.length`
// only (never names), realtime-mode shows the full `votes` tally, runoff
// variant renders only `runoffCandidates`.
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientPlayerView } from "../../../shared/protocol";
import { castVote, retractVote } from "../../store/gameStore";
import { Redaction } from "../../components/ui/dossier";

export default function DayVoting({
  game,
  players,
}: {
  game: ClientGameView;
  players: ClientPlayerView[];
}) {
  const playerNames = new Map(players.map((p) => [p.id, p.name]));
  const you = game.you;
  const alive = you?.alive ?? false;
  const isRunoff = game.phase === "runoff";

  // `you.currentVote` (Spec 02 v2.6) is the viewer's own standing vote,
  // present for every living viewer regardless of votingVisibility — this
  // replaced an earlier local-state mirror of the just-cast target, which
  // lost the highlight on a page reload mid-vote (the projection now closes
  // that gap directly, so the store's hydrated snapshot is the only source
  // of truth here, same as everything else in this component).
  const myVote = you?.currentVote ?? null;

  function vote(target: string) {
    castVote(target);
  }

  function retract() {
    retractVote();
  }

  const livingCandidates = (isRunoff ? (game.runoffCandidates ?? []) : game.players.filter((p) => p.alive).map((p) => p.id))
    .map((id) => ({ id, name: playerNames.get(id) ?? id }));

  const showTally = game.votes !== undefined;
  const votedCount = game.voted?.length ?? game.votes?.length ?? 0;
  const totalAlive = game.players.filter((p) => p.alive).length;

  function tallyFor(targetId: string): number | null {
    if (!game.votes) return null;
    return game.votes.filter((v) => v.target === targetId).length;
  }

  return (
    <div className="animate-rise flex flex-col gap-6 px-4 py-6" data-testid="day-voting">
      <div className="text-center">
        <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">
          Interrogation · File Day {game.day}
        </p>
        <h1 className="file-heading text-3xl text-bone">
          {isRunoff ? "The Runoff" : "Name a suspect"}
        </h1>
      </div>

      {you?.investigationResults && you.investigationResults.length > 0 && (
        <div
          data-testid="investigation-history"
          className="flex flex-col gap-1 rounded-sm border border-frame bg-ink-3 p-3 text-sm"
        >
          <p className="mb-1 text-[0.65rem] uppercase tracking-[0.15em] text-smoke">
            Case findings
          </p>
          {you.investigationResults.map((r) => (
            <p key={`${r.day}-${r.targetId}`}>
              Night {r.day}: {playerNames.get(r.targetId) ?? r.targetId} —{" "}
              <span className={r.isMafia ? "text-blood" : "text-paper"}>
                {r.isMafia ? "Mafia" : "Not mafia"}
              </span>
            </p>
          ))}
        </div>
      )}

      {you?.mafiaRoster && (
        <div
          data-testid="mafia-roster"
          className="rounded-sm border border-blood/60 bg-ink-3 p-3 text-sm"
        >
          <p className="mb-1 text-[0.65rem] uppercase tracking-[0.15em] text-smoke">
            The Syndicate
          </p>
          {you.mafiaRoster.length === 0 ? (
            <p className="text-paper/80">No known associates.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {you.mafiaRoster.map((id) => (
                <li key={id} className="text-blood">
                  {playerNames.get(id) ?? id}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!alive ? (
        <p className="text-center text-smoke">
          // case closed for you — watch the town decide.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-2" data-testid="vote-grid">
            {livingCandidates.map((c) => {
              const mine = myVote === c.id;
              const count = tallyFor(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  data-testid="vote-option"
                  data-target-id={c.id}
                  data-voted={mine}
                  onClick={() => vote(c.id)}
                  className={`flex min-h-11 items-center justify-between rounded-sm border px-4 py-3 text-left transition-colors ${
                    mine
                      ? "border-brass bg-ink-3 text-brass-hi"
                      : "border-frame bg-ink-2 text-paper"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {mine && (
                      <span aria-hidden className="text-[0.6rem] uppercase tracking-[0.15em] text-blood">
                        ✗
                      </span>
                    )}
                    {c.name}
                  </span>
                  {showTally && count !== null && (
                    <span className="text-sm tabular-nums text-smoke">{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* The runoff variant renders only `runoffCandidates` (spec pin) —
              no_murder is a day-1-vote-only option, never offered once a
              runoff between tied players is underway. */}
          {!isRunoff && (
            <NoMurderCard mine={myVote === "no_murder"} onVote={() => vote("no_murder")} />
          )}

          {myVote !== null && (
            <button
              type="button"
              data-testid="retract-vote"
              onClick={retract}
              className="min-h-11 text-sm text-smoke underline"
            >
              Withdraw my accusation
            </button>
          )}
        </div>
      )}

      {/* The tally. Under hidden voting the individual ballots are sealed —
          shown as a redaction bar next to the honest "N of M have voted"
          count (the exact string the E2E asserts on, unchanged). Realtime
          voting drops the redaction and shows live counts on each option. */}
      <div
        data-testid="vote-tally"
        data-mode={showTally ? "realtime" : "hidden"}
        className="flex items-center justify-center gap-2 text-center text-sm text-smoke"
      >
        {showTally ? (
          "Votes are visible in real time."
        ) : (
          <>
            <Redaction width="2.5rem" label="sealed ballots" />
            <span>{`${votedCount} of ${totalAlive} have voted.`}</span>
          </>
        )}
      </div>
    </div>
  );
}

function NoMurderCard({ mine, onVote }: { mine: boolean; onVote: () => void }) {
  return (
    <button
      type="button"
      data-testid="vote-option-no-murder"
      data-voted={mine}
      onClick={onVote}
      className={`min-h-11 rounded-sm border-2 border-dashed px-4 py-3 text-center text-sm font-bold uppercase tracking-[0.1em] transition-colors ${
        mine ? "border-brass text-brass-hi" : "border-frame text-paper"
      }`}
    >
      No case tonight
    </button>
  );
}
