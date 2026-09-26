// The player table (D1 centerpiece) — one row per seat, join order, never
// reordered. Two variants: lobby (name + presence + kick) and in-game (name +
// role[alignment-tinted] + alive/connected/absent + this-phase status + row
// actions). Both read from the same `HostSeatRow[]` shape (store/hostView.ts)
// so the columns that exist in both modes render identically.
import type { HostSeatRow } from "../../store/hostView";
import { alignmentTint } from "../../store/hostView";
import { Badge, type BadgeVariant } from "../../components/ui/badge";
import { roleCopyFor } from "../../lib/roleCopy";

// Alignment tint -> role Badge variant (all lowercase keys — safe against the
// player-privacy innerHTML scan; see badge.tsx). This is the host console, so
// the human-readable role name is allowed here regardless.
const ROLE_BADGE_VARIANT: Record<ReturnType<typeof alignmentTint>, BadgeVariant> = {
  blood: "role-mafia",
  bone: "role-town",
  brass: "role-neutral",
  smoke: "neutral",
};

function StatusCell({ row }: { row: HostSeatRow }) {
  if (!row.alive) {
    return <Badge variant="muted">dead</Badge>;
  }
  if (row.absent) {
    return <Badge variant="active">absent</Badge>;
  }
  switch (row.status.kind) {
    case "voted":
      return <Badge variant="active">voted</Badge>;
    case "not-voted":
      return <Badge variant="muted">pending</Badge>;
    // Night phase, per-seat `players[].acted` (Spec 02 v2.7): "acted" for a
    // submitted night action/mafia-consensus vote, "pending" for a seat that
    // owes one and hasn't yet, "asleep" for a seat with no owed action this
    // phase (villager/minion/bomber-style roles) — never a fabricated
    // pending for a role with nothing to submit.
    case "acted":
      return <Badge variant="active">acted</Badge>;
    case "pending":
      return <Badge variant="muted">pending</Badge>;
    case "asleep":
      return <Badge variant="muted">asleep</Badge>;
    case "no-vote-phase":
      return <Badge variant="muted">—</Badge>;
    case "unknown":
      return <Badge variant="muted">no live signal</Badge>;
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
        const roleVariant = ROLE_BADGE_VARIANT[alignmentTint(row.alignment)];
        return (
          <li
            key={row.id}
            data-testid="host-player-row"
            data-player-id={row.id}
            data-alive={row.alive}
            data-absent={row.absent}
            data-connected={row.connected}
            className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-sm border border-frame bg-ink-2 px-4 py-2"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
              <span
                aria-hidden
                data-testid="host-presence-dot"
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                  row.connected ? "bg-brass-hi" : "bg-smoke/50"
                }`}
                title={row.connected ? "connected" : "disconnected"}
              />
              <span className={`min-w-0 break-words sm:truncate ${row.alive ? "text-paper" : "text-smoke line-through"}`}>
                {row.name}
              </span>
              {inGame && copy && (
                <Badge data-testid="host-player-role" variant={roleVariant}>
                  {copy.displayName}
                </Badge>
              )}
            </div>

            {inGame && (
              <span data-testid="host-player-status">
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
                    className="min-h-11 rounded-sm border border-brass px-2 py-1 text-[0.65rem] uppercase tracking-[0.1em] text-brass-hi"
                  >
                    Mark present
                  </button>
                ) : (
                  row.alive && (
                    <button
                      type="button"
                      data-testid="mark-absent-button"
                      onClick={() => onMarkAbsent?.(row.id)}
                      className="min-h-11 rounded-sm border border-frame px-2 py-1 text-[0.65rem] uppercase tracking-[0.1em] text-smoke"
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
                  className="min-h-11 rounded-sm border border-blood px-2 py-1 text-[0.65rem] uppercase tracking-[0.1em] text-blood-hi"
                >
                  Dismiss
                </button>
              )}
            </div>
          </li>
        );
      })}
      {rows.length === 0 && (
        <li className="text-center text-smoke">// awaiting subjects…</li>
      )}
    </ul>
  );
}
