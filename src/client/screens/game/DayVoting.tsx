// Day+Voting (D3, Spec 11): select → confirm. `castVote` sets a TENTATIVE
// vote (freely changeable, incl. no_murder); "Confirm accusation"
// (`confirmVote`) locks it; changing the pick or "Reconsider" (`unconfirmVote`)
// returns it to tentative. The phase resolves only once every living player is
// LOCKED (server-authoritative). The player sees ONLY their own state
// (tentative / locked / waiting) — never a denominator or per-seat tally (the
// Spec 11 no-pending-count leak ban); the host god-view is the only place a
// vote count appears. Realtime-visibility mode still shows the public ballot
// list (an explicit ruleset opt-in), never a "who hasn't voted" count.
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientPlayerView } from "../../../shared/protocol";
import { castVote, confirmVote, retractVote, unconfirmVote } from "../../store/gameStore";
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

  const myVote = you?.currentVote ?? null;
  const locked = you?.dayVoteLocked ?? false;

  function vote(target: string) {
    castVote(target);
  }

  function retract() {
    retractVote();
  }

  const livingCandidates = (isRunoff ? (game.runoffCandidates ?? []) : game.players.filter((p) => p.alive).map((p) => p.id))
    .map((id) => ({ id, name: playerNames.get(id) ?? id }));

  // Realtime-visibility rooms (an explicit ruleset opt-in) still expose the
  // public ballots via `game.votes`; hidden rooms (the default) never do.
  const showTally = game.votes !== undefined;

  function tallyFor(targetId: string): number | null {
    if (!game.votes) return null;
    return game.votes.filter((v) => v.target === targetId).length;
  }

  const myVoteName = myVote === "no_murder" ? "No murder this round" : myVote ? (playerNames.get(myVote) ?? myVote) : null;

  return (
    <div
      className="animate-rise flex min-h-[calc(100dvh-9rem)] flex-col gap-5 px-4 pb-8 pt-3"
      data-testid="day-voting"
    >
      <div className="text-center">
        <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">
          Interrogation · File Day {game.day}
        </p>
        <h1 className="file-heading text-3xl text-bone">
          {isRunoff ? "The Runoff" : "Name a suspect"}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-paper/80">
          {isRunoff
            ? "The tie is limited to the marked suspects. Choose one, then confirm."
            : "Choose one living suspect, or record no murder, then confirm your ballot."}
        </p>
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
              <span className={r.isMafia ? "text-blood-hi" : "text-paper"}>
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
                <li key={id} className="text-blood-hi">
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
          <div className="grid grid-cols-1 gap-2" data-testid="vote-grid" aria-label="Living suspects">
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
                  data-locked={mine && locked}
                  aria-pressed={mine}
                  disabled={locked}
                  onClick={() => vote(c.id)}
                  className={`flex min-h-11 items-center justify-between rounded-sm border px-4 py-3 text-left transition-colors disabled:opacity-60 ${
                    mine
                      ? "border-brass bg-ink-3 text-brass-hi"
                      : "border-frame bg-ink-2 text-paper"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {mine && (
                      <span aria-hidden className="text-[0.6rem] uppercase tracking-[0.15em] text-blood-hi">
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
            <NoMurderCard
              mine={myVote === "no_murder"}
              locked={locked}
              onVote={() => vote("no_murder")}
            />
          )}

          {myVote !== null && !locked && (
            <p
              data-testid="vote-selection-status"
              className="rounded-sm border border-brass/40 bg-ink-3 px-3 py-2 text-center text-sm text-brass-hi"
              aria-live="polite"
            >
              {myVote === "no_murder"
                ? "No murder selected. Confirm to file this ballot."
                : `${myVoteName} selected. Confirm to file this ballot.`}
            </p>
          )}

          {/* Select → confirm. A tentative pick shows "Confirm accusation"
              (locks it); a locked pick shows "Reconsider" (returns to
              tentative). This is the day-vote analog of the night lock-in —
              the same shared readiness gate resolves the phase once everyone
              is locked. */}
          {myVote !== null && (
            <div className="flex flex-col gap-2">
              {locked ? (
                <>
                  <div
                    data-testid="vote-locked-state"
                    className="animate-brass-pulse rounded-sm border border-brass/60 bg-ink-3 p-3 text-center text-sm text-brass-hi"
                  >
                    {myVote === "no_murder"
                      ? "No-murder ballot filed. Waiting on the rest of the room…"
                      : `Accusation filed against ${myVoteName}. Waiting on the rest of the room…`}
                  </div>
                  <button
                    type="button"
                    data-testid="unconfirm-vote-button"
                    onClick={() => unconfirmVote()}
                    className="min-h-11 text-sm text-smoke underline"
                  >
                    Reconsider
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    data-testid="confirm-vote-button"
                    onClick={() => confirmVote()}
                    className="min-h-11 rounded-sm border-2 border-brass bg-ink-3 px-4 py-3 text-sm font-bold uppercase tracking-[0.1em] text-brass-hi transition-colors"
                  >
                    Confirm accusation
                  </button>
                  <button
                    type="button"
                    data-testid="retract-vote"
                    onClick={retract}
                    className="min-h-11 text-sm text-smoke underline"
                  >
                    Withdraw my accusation
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* The player never sees a denominator/tally of who has voted (Spec 11
          no-pending-count leak ban) — only their own state above. Realtime
          rooms still show the public ballot counts on each option. */}
      <div
        data-testid="vote-tally"
        data-mode={showTally ? "realtime" : "hidden"}
        className="mt-auto flex items-center justify-center gap-2 text-center text-sm text-smoke"
      >
        {showTally ? (
          "Votes are visible in real time."
        ) : (
          <>
            <Redaction width="2.5rem" label="sealed ballots" />
            <span>The ballots are sealed until the vote closes.</span>
          </>
        )}
      </div>
    </div>
  );
}

function NoMurderCard({ mine, locked, onVote }: { mine: boolean; locked: boolean; onVote: () => void }) {
  return (
    <button
      type="button"
      data-testid="vote-option-no-murder"
      data-voted={mine}
      data-locked={mine && locked}
      aria-pressed={mine}
      disabled={locked}
      onClick={onVote}
      className={`min-h-11 rounded-sm border-2 border-dashed px-4 py-3 text-center text-sm font-bold uppercase tracking-[0.1em] transition-colors disabled:opacity-60 ${
        mine ? "border-brass text-brass-hi" : "border-frame text-paper"
      }`}
    >
      No murder this round
    </button>
  );
}
