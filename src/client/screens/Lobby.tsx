import type { ClientRoomState } from "../../shared/protocol";
import { Button } from "../components/ui/button";
import { FileCard } from "../components/ui/dossier";
import HelpButton from "../components/HelpButton";
import { recommendedRoleCounts } from "../../engine";
import { roleCopyFor } from "../lib/roleCopy";

// Spec 11: the roster the host has dialed in, counts only (never assignments).
// Villagers are the auto remainder, computed against the current player count.
// Spec 13: "auto" roles (a fresh room broadcasts all-auto) resolve via the
// same `recommendedRoleCounts` the engine uses server-side.
const ROSTER_ROLE_ORDER = ["mafia", "detective", "angel", "suicide_bomber", "minion"];

function PendingRosterCard({ state }: { state: ClientRoomState }) {
  const roles = state.pendingRuleset?.roles;
  if (!roles) return null;
  const recommended = recommendedRoleCounts(state.players.length);
  const resolved = ROSTER_ROLE_ORDER.map((id) => {
    const v = roles[id];
    return { id, count: typeof v === "number" ? v : (recommended[id] ?? 0) };
  }).filter((r) => r.count > 0);
  const resolvedTotal = resolved.reduce((sum, r) => sum + r.count, 0);
  const villagerCount =
    roles.villager === "auto"
      ? Math.max(0, state.players.length - resolvedTotal)
      : typeof roles.villager === "number"
        ? roles.villager
        : 0;
  const entries = [
    ...resolved.map((r) => ({ name: roleCopyFor(r.id).displayName, count: r.count })),
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
  const you = state.players.find((player) => player.isYou);

  return (
    <main data-testid="player-lobby" className="room-page page-p relative z-10 mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 text-paper">
      <div className="flex w-full items-start justify-between gap-3">
        <div className="flex flex-col">
          <p className="text-[0.65rem] uppercase tracking-[0.24em] text-smoke">
            Waiting room
          </p>
          <h1 className="file-heading text-2xl text-bone">Join the table</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-frame bg-ink-2 px-2.5 py-1 text-[0.65rem] uppercase tracking-[0.12em] text-smoke">
            {state.players.length} joined
          </span>
          <HelpButton />
        </div>
      </div>

      <section className="lobby-seat-card flex flex-col gap-3 p-4" aria-labelledby="room-code-label">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p id="room-code-label" className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
              Room code
            </p>
            <span data-testid="room-code" className="lobby-code mt-1">
              {state.roomCode}
            </span>
          </div>
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
        <p className="text-sm leading-relaxed text-paper/75">
          Share this code with anyone still joining. The host will start the case when the table is ready.
        </p>
      </section>

      <section className="lobby-next-step flex flex-col gap-2 p-4" data-testid="lobby-next-step" aria-live="polite">
        <p className="text-[0.65rem] uppercase tracking-[0.2em] text-brass-hi">Next step</p>
        <p className="text-base font-semibold text-bone">
          {you ? `You are ${you.name}. Wait for the host to start.` : "Choose a seat to join the table."}
        </p>
        <p className="text-sm leading-relaxed text-paper/75">
          Roles stay secret. Keep your phone to yourself once the case begins; the table will do the talking during the day.
        </p>
      </section>

      {you && (
        <section className="flex items-center justify-between gap-3 rounded-md border border-frame bg-ink-2 px-4 py-3" data-testid="your-seat">
          <div>
            <p className="text-[0.63rem] uppercase tracking-[0.18em] text-smoke">Your seat</p>
            <p className="mt-1 text-sm font-semibold text-bone">{you.name}</p>
          </div>
          <span className="rounded-full border border-brass/70 bg-brass/10 px-2.5 py-1 text-[0.65rem] uppercase tracking-[0.12em] text-brass-hi">
            {you.connected ? "Connected" : "Reconnecting"}
          </span>
        </section>
      )}

      <p className="flex items-center justify-between text-xs text-smoke" aria-live="polite">
        <span>{state.hostConnected ? "Host is here" : "Waiting for the host to reconnect"}</span>
        <span>{state.players.length} of 3 minimum joined</span>
      </p>

      <FileCard tab="Players at the table" className="w-full p-3">
        <ul className="flex flex-col gap-2" data-testid="player-list">
          {state.players.map((p, i) => (
            <li
              key={p.id}
              data-testid="player-row"
              data-player-id={p.id}
              data-connected={p.connected}
              className="flex min-h-11 items-center justify-between rounded-sm border border-frame bg-ink-3 px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-smoke tabular-nums" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span
                  aria-hidden
                  data-testid="presence-dot"
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                    p.connected ? "bg-brass-hi" : "bg-smoke/50"
                  }`}
                />
                <span className="truncate">{p.name}</span>
                {p.isYou && <span className="shrink-0 text-smoke">(you)</span>}
              </span>
              {isHost && !p.isYou && (
                <button
                  type="button"
                  data-testid="kick-button"
                  onClick={() => onKick(p.id)}
                  className="min-h-11 shrink-0 rounded-sm border border-blood px-2 py-1 text-[0.65rem] uppercase tracking-[0.1em] text-blood-hi"
                >
                  Dismiss
                </button>
              )}
            </li>
          ))}
          {state.players.length === 0 && (
            <li className="file-frame rounded-sm px-4 py-6 text-center text-smoke">
              Waiting for the first player…
            </li>
          )}
        </ul>
      </FileCard>

      <PendingRosterCard state={state} />

      {isHost && (
        <div className="flex w-full flex-col gap-2">
          <p className="text-xs text-smoke">{state.players.length < 3 ? "Need at least 3 players to start." : "The host can start when everyone is ready."}</p>
          <Button
            type="button"
            data-testid="start-game"
            onClick={onStartGame}
            disabled={state.players.length < 3}
            variant="brass"
            size="lg"
            className="w-full"
          >
            Open the case (house rules)
          </Button>
        </div>
      )}
    </main>
  );
}
