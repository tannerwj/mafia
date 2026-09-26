// Spec 12 Feature 3: the all-player "The Case So Far" status panel — a
// read-only view ANY player (living or dead) can open at ANY time. It renders
// exactly two projection fields, both AGGREGATE-ONLY and present for every
// viewer (see project.ts): `graveyard` (dead players + role per revealOnDeath)
// and `rolesRemaining` ({roleId, count} — NEVER a per-living-player list). It
// carries no phase logic and must not interfere with flow — it's a Dialog
// layered over whatever screen is active.
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { ClientGameView } from "../../../shared/game-view";
import { roleCopyFor } from "../../lib/roleCopy";

function alignmentLabel(alignment: string | undefined): string {
  if (alignment === "mafia") return "Mafia-aligned";
  if (alignment === "town") return "Town-aligned";
  if (alignment === "neutral") return "Neutral";
  return "Allegiance sealed";
}

export default function GameStatus({
  game,
  playerNames,
}: {
  game: ClientGameView;
  playerNames: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const graveyard = game.graveyard ?? [];
  const rolesRemaining = game.rolesRemaining ?? [];
  const headcount = game.headcount ?? { alive: 0, total: 0 };

  return (
    <>
      <button
        type="button"
        data-testid="game-status-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="chip-inset-tl fixed z-60 flex h-11 items-center gap-2 rounded-sm border-2 border-frame bg-ink-2 px-3 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-brass-hi shadow-lg"
      >
        The Case So Far
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/80" />
          <Dialog.Content
            data-testid="game-status-panel"
            className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-sm border-2 border-frame bg-ink-2 p-6 text-paper shadow-card"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">
                  Case file · Day {game.day}
                </p>
                <Dialog.Title asChild>
                  <h2 className="file-heading text-2xl text-bone">The Case So Far</h2>
                </Dialog.Title>
                <Dialog.Description asChild>
                  <p className="mt-1 text-sm text-smoke">
                    {headcount.alive} of {headcount.total} still in play.
                  </p>
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  data-testid="game-status-close"
                  aria-label="Close"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-frame text-lg text-smoke"
                >
                  ✕
                </button>
              </Dialog.Close>
            </div>

            <section>
              <p className="mb-2 text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
                Still among the living
              </p>
              <ul data-testid="roles-remaining" className="flex flex-col gap-1">
                {rolesRemaining.length === 0 ? (
                  <li className="text-sm text-smoke">// no one left.</li>
                ) : (
                  rolesRemaining.map((r) => (
                    <li
                      key={r.roleId}
                      data-testid="roles-remaining-row"
                      data-role-id={r.roleId}
                      data-count={r.count}
                      className="flex items-center justify-between rounded-sm border border-frame bg-ink-3 px-3 py-2 text-sm"
                    >
                      <span className="text-paper">{roleCopyFor(r.roleId).displayName}</span>
                      <span className="tabular-nums text-brass-hi">{r.count}</span>
                    </li>
                  ))
                )}
              </ul>
            </section>

            <section>
              <p className="mb-2 text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
                The graveyard
              </p>
              <ul data-testid="graveyard" className="flex flex-col gap-1">
                {graveyard.length === 0 ? (
                  <li className="text-sm text-smoke">// no casualties yet.</li>
                ) : (
                  graveyard.map((g) => {
                    const roleLabel = g.roleId
                      ? roleCopyFor(g.roleId).displayName
                      : g.alignment
                        ? alignmentLabel(g.alignment)
                        : "Role undisclosed";
                    return (
                      <li
                        key={g.playerId}
                        data-testid="graveyard-row"
                        data-player-id={g.playerId}
                        className="flex items-center justify-between gap-2 rounded-sm border border-frame/50 bg-ink-3 px-3 py-2 text-sm opacity-80"
                      >
                        <span className="text-smoke line-through">
                          {playerNames.get(g.playerId) ?? g.playerId}
                        </span>
                        <span className="text-right text-smoke">
                          {roleLabel}
                          <span className="ml-1 text-[0.65rem] uppercase tracking-[0.1em]">
                            · {g.cause === "night" ? `Night ${g.day}` : `Day ${g.day} vote`}
                          </span>
                        </span>
                      </li>
                    );
                  })
                )}
              </ul>
            </section>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
