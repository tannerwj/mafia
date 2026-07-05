// HostGame (D1): player table (centerpiece) + phase header + full log +
// dangerous controls. Mobile (<=430px): single column, controls in a bottom
// drawer. Desktop (>=768px): two columns — player table left, log+controls
// right (`max-w-3xl`, matching the spec's pinned layout convention).
import { Drawer } from "vaul";
import { useState } from "react";
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientRoomState } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import ConfirmDialog from "../../components/ConfirmDialog";
import HelpButton from "../../components/HelpButton";
import { forceAdvance, markAbsent, markPresent } from "../../store/gameStore";
import { forceAdvanceCopy, hostSeatRows, phaseLabel, phaseSummary } from "../../store/hostView";
import DeadlineCountdown from "./DeadlineCountdown";
import { PlayerTable } from "./PlayerTable";
import PrivacyChip from "./PrivacyChip";
import HostLog from "./HostLog";

function PhaseHeader({ game, rows }: { game: ClientGameView; rows: ReturnType<typeof hostSeatRows> }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-smoke/60 bg-ink-2 px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="font-display text-2xl text-bone" data-testid="host-phase-label">
          {phaseLabel(game.phase)} — Day {game.day}
        </p>
        <DeadlineCountdown deadlineAt={game.deadlineAt} />
      </div>
      <p className="text-sm text-smoke" data-testid="host-phase-summary">
        {phaseSummary(game, rows)}
      </p>
    </div>
  );
}

function ForceAdvanceControl({ game }: { game: ClientGameView }) {
  const [open, setOpen] = useState(false);
  // Captured at the moment the confirm dialog OPENS (D2 pin) — if the phase
  // has moved by the time the host confirms, the engine rejects
  // `stale_advance` and the store's rejection toast reads "already advanced".
  const [capturedGen, setCapturedGen] = useState<number | null>(null);

  function openDialog() {
    setCapturedGen(game.phaseGen);
    setOpen(true);
  }

  return (
    <>
      <Button
        type="button"
        data-testid="force-advance-button"
        variant="destructive"
        onClick={openDialog}
        disabled={game.phase === "ended"}
        className="w-full"
      >
        Force advance
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        testId="force-advance-confirm"
        title="Force advance the phase?"
        description={forceAdvanceCopy(game.phase)}
        confirmLabel="Force advance"
        onConfirm={() => {
          if (capturedGen !== null) forceAdvance(capturedGen);
        }}
      />
    </>
  );
}

function Controls({ game }: { game: ClientGameView }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs uppercase tracking-widest text-smoke">Controls</p>
      <ForceAdvanceControl game={game} />
      <p className="text-xs text-smoke">
        Mark players absent/present from their row in the table — absent players are
        removed from every consensus/vote denominator immediately.
      </p>
    </div>
  );
}

export default function HostGame({ room, game }: { room: ClientRoomState; game: ClientGameView }) {
  const rows = hostSeatRows(room);
  const playerNames = new Map(room.players.map((p) => [p.id, p.name]));
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <main className="safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 bg-ink p-4 text-bone">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-2xl text-blood">Host console</h1>
        <div className="flex items-center gap-2">
          <HelpButton />
          <PrivacyChip />
        </div>
      </div>

      <PhaseHeader game={game} rows={rows} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-2">
          <p className="text-xs uppercase tracking-widest text-smoke">Players</p>
          <PlayerTable
            rows={rows}
            inGame
            onMarkAbsent={(id) => markAbsent(id)}
            onMarkPresent={(id) => markPresent(id)}
          />
        </div>

        <div className="flex min-h-0 flex-col gap-4">
          {/* Desktop: controls inline, right column. Mobile: controls move
              into a bottom drawer (D1 layout pin) so the log/table stay the
              primary view on a phone. */}
          <div className="hidden md:flex md:flex-col md:gap-4">
            <Controls game={game} />
          </div>
          <HostLog game={game} playerNames={playerNames} />
        </div>
      </div>

      <div className="md:hidden">
        <Button
          type="button"
          data-testid="open-controls-drawer"
          variant="outline"
          className="w-full"
          onClick={() => setDrawerOpen(true)}
        >
          Controls
        </Button>
        <Drawer.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-40 bg-ink/80" />
            <Drawer.Content
              data-testid="controls-drawer"
              className="fixed bottom-0 left-0 right-0 z-50 mx-auto flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl border-t border-smoke bg-ink-2 p-6"
            >
              <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-smoke" />
              <Drawer.Title asChild>
                <h2 className="font-display text-2xl text-bone">Controls</h2>
              </Drawer.Title>
              <Drawer.Description asChild>
                <span className="sr-only">Host controls for the current phase.</span>
              </Drawer.Description>
              <div className="safe-bottom mt-4 overflow-y-auto">
                <Controls game={game} />
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      </div>
    </main>
  );
}
