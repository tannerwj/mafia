import type { ClientRoomState } from "../../shared/protocol";
import { Button } from "../components/ui/button";
import { FileCard } from "../components/ui/dossier";
import HelpButton from "../components/HelpButton";
import { roleCopyFor } from "../lib/roleCopy";

// Spec 11: the roster the host has dialed in, counts only (never assignments).
// Villagers are the auto remainder, computed against the current player count.
const ROSTER_ROLE_ORDER = ["mafia", "detective", "angel", "suicide_bomber", "minion"];

function PendingRosterCard({ state }: { state: ClientRoomState }) {
  const roles = state.pendingRuleset?.roles;
  if (!roles) return null;
  const explicit = ROSTER_ROLE_ORDER.map((id) => {
    const v = roles[id];
    return { id, count: typeof v === "number" ? v : 0 };
  }).filter((r) => r.count > 0);
  const explicitTotal = explicit.reduce((sum, r) => sum + r.count, 0);
  const villagerCount =
    roles.villager === "auto"
      ? Math.max(0, state.players.length - explicitTotal)
      : typeof roles.villager === "number"
        ? roles.villager
        : 0;
  const entries = [
    ...explicit.map((r) => ({ name: roleCopyFor(r.id).displayName, count: r.count })),
    ...(villagerCount > 0 ? [{ name: "Villager", count: villagerCount }] : []),
  ];
  return (
    <FileCard tab="The cast" className="w-full max-w-sm p-3">
      <ul data-testid="pending-ruleset-summary" className="flex flex-col gap-1 text-sm text-paper/80">
        {entries.map((e) => (
          <li key={e.name} className="flex items-center justify-between">
            <span>{e.name}</span>
            <span className="tabular-nums text-brass-hi">{e.count}</span>
          </li>
        ))}
      </ul>
    </FileCard>
  );
}

export default function Lobby({
  state,
  isHost,
  onKick,
  onCopyLink,
  onStartGame,
}: {
  state: ClientRoomState;
  isHost: boolean;
  onKick: (playerId: string) => void;
  onCopyLink: () => void;
  onStartGame: () => void;
}) {
  return (
    <main className="safe-top safe-bottom safe-x relative z-10 mx-auto flex min-h-dvh w-full max-w-md flex-col items-center gap-6 bg-ink p-6 text-paper">
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex flex-col">
          <p className="text-[0.65rem] uppercase tracking-[0.3em] text-smoke">
            Assembling subjects
          </p>
          <h1 className="file-heading text-2xl text-blood">The Roster</h1>
        </div>
        <HelpButton />
      </div>

      <div className="flex items-center gap-3">
        <span
          data-testid="room-code"
          className="rounded-md border border-frame bg-ink-2 px-4 py-2 text-2xl tracking-[0.3em] text-brass-hi"
        >
          {state.roomCode}
        </span>
        {isHost && (
          <Button
            type="button"
            data-testid="copy-link"
            onClick={onCopyLink}
            variant="outline"
            size="sm"
          >
            Copy link
          </Button>
        )}
      </div>

      <p className="text-xs uppercase tracking-[0.15em] text-smoke">
        Investigator: {state.hostConnected ? "on the line" : "not connected"}
      </p>

      <FileCard tab="Subjects on file" className="w-full max-w-sm p-3">
        <ul className="flex flex-col gap-2" data-testid="player-list">
          {state.players.map((p, i) => (
            <li
              key={p.id}
              data-testid="player-row"
              data-player-id={p.id}
              data-connected={p.connected}
              className="flex min-h-11 items-center justify-between rounded-sm border border-frame bg-ink-3 px-3 py-2"
            >
              <span className="flex items-center gap-2">
                <span className="text-smoke tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span
                  aria-hidden
                  data-testid="presence-dot"
                  className={`inline-block h-2 w-2 rounded-full ${
                    p.connected ? "bg-brass-hi" : "bg-smoke/50"
                  }`}
                />
                {p.name}
                {p.isYou && <span className="text-smoke"> (you)</span>}
              </span>
              {isHost && !p.isYou && (
                <button
                  type="button"
                  data-testid="kick-button"
                  onClick={() => onKick(p.id)}
                  className="min-h-11 rounded-sm border border-blood px-2 py-1 text-[0.65rem] uppercase tracking-[0.1em] text-blood"
                >
                  Dismiss
                </button>
              )}
            </li>
          ))}
          {state.players.length === 0 && (
            <li className="file-frame rounded-sm px-4 py-6 text-center text-smoke">
              Awaiting subjects…
            </li>
          )}
        </ul>
      </FileCard>

      <PendingRosterCard state={state} />

      {isHost && (
        <Button
          type="button"
          data-testid="start-game"
          onClick={onStartGame}
          disabled={state.players.length < 3}
          variant="brass"
          size="lg"
          className="w-full max-w-sm"
        >
          Open the case (house rules)
        </Button>
      )}
    </main>
  );
}
