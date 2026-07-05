// The player table (D1 centerpiece) — one row per seat, join order, never
// reordered. Two variants: lobby (name + presence + kick) and in-game (name +
// role[alignment-tinted] + alive/connected/absent + this-phase status + row
// actions). Both read from the same `HostSeatRow[]` shape (store/hostView.ts)
// so the columns that exist in both modes render identically.
import type { HostSeatRow } from "../../store/hostView";
import { alignmentTint } from "../../store/hostView";
import { roleCopyFor } from "../../lib/roleCopy";

const TINT_CLASS: Record<ReturnType<typeof alignmentTint>, string> = {
  blood: "text-blood",
  bone: "text-bone",
  brass: "text-brass",
  smoke: "text-smoke",
};

function StatusCell({ row }: { row: HostSeatRow }) {
  if (!row.alive) {
    return <span className="text-smoke">dead</span>;
  }
  if (row.absent) {
    return <span className="text-brass">absent</span>;
  }
  switch (row.status.kind) {
    case "voted":
      return <span className="text-brass">voted</span>;
    case "not-voted":
      return <span className="text-smoke">pending</span>;
    // Night phase, per-seat `players[].acted` (Spec 02 v2.7): "acted" for a
    // submitted night action/mafia-consensus vote, "pending" for a seat that
    // owes one and hasn't yet, "asleep" for a seat with no owed action this
    // phase (villager/minion/bomber-style roles) — never a fabricated
    // pending for a role with nothing to submit.
    case "acted":
      return <span className="text-brass">acted</span>;
    case "pending":
      return <span className="text-smoke">pending</span>;
    case "asleep":
      return <span className="text-smoke">asleep</span>;
    case "no-vote-phase":
      return <span className="text-smoke">—</span>;
    case "unknown":
      return <span className="text-smoke">no live signal</span>;
  }
}

export function PlayerTable({
  rows,
  inGame,
  onMarkAbsent,
  onMarkPresent,
  onKick,
  lobbyMode,
}: {
  rows: HostSeatRow[];
  inGame: boolean;
  onMarkAbsent?: (playerId: string) => void;
  onMarkPresent?: (playerId: string) => void;
  onKick?: (playerId: string) => void;
  lobbyMode?: boolean;
}) {
  return (
    <ul className="flex w-full flex-col gap-2" data-testid="host-player-table">
      {rows.map((row) => {
        const copy = row.roleId ? roleCopyFor(row.roleId) : null;
        const tint = TINT_CLASS[alignmentTint(row.alignment)];
        return (
          <li
            key={row.id}
            data-testid="host-player-row"
            data-player-id={row.id}
            data-alive={row.alive}
            data-absent={row.absent}
            data-connected={row.connected}
            className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border border-smoke/60 bg-ink-2 px-4 py-2"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span
                aria-hidden
                data-testid="host-presence-dot"
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                  row.connected ? "bg-brass" : "bg-smoke"
                }`}
                title={row.connected ? "connected" : "disconnected"}
              />
              <span className={`truncate ${row.alive ? "text-bone" : "text-smoke line-through"}`}>
                {row.name}
              </span>
              {inGame && copy && (
                <span
                  data-testid="host-player-role"
                  className={`font-display text-sm ${tint}`}
                >
                  {copy.displayName}
                </span>
              )}
            </div>

            {inGame && (
              <span data-testid="host-player-status" className="text-xs uppercase tracking-wide">
                <StatusCell row={row} />
              </span>
            )}

            <div className="flex items-center gap-2">
              {inGame &&
                (row.absent ? (
                  <button
                    type="button"
                    data-testid="mark-present-button"
                    onClick={() => onMarkPresent?.(row.id)}
                    className="min-h-11 rounded-md border border-brass px-2 py-1 text-xs text-brass"
                  >
                    Mark present
                  </button>
                ) : (
                  row.alive && (
                    <button
                      type="button"
                      data-testid="mark-absent-button"
                      onClick={() => onMarkAbsent?.(row.id)}
                      className="min-h-11 rounded-md border border-smoke px-2 py-1 text-xs text-smoke"
                    >
                      Mark absent
                    </button>
                  )
                ))}
              {lobbyMode && onKick && (
                <button
                  type="button"
                  data-testid="kick-button"
                  onClick={() => onKick(row.id)}
                  className="min-h-11 rounded-md border border-blood px-2 py-1 text-xs text-blood"
                >
                  Kick
                </button>
              )}
            </div>
          </li>
        );
      })}
      {rows.length === 0 && (
        <li className="text-center text-smoke">Waiting for players to join…</li>
      )}
    </ul>
  );
}
