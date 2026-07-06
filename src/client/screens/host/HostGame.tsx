// HostGame (D1): player table (centerpiece) + phase header + full log +
// dangerous controls. Mobile (<=430px): single column, controls in a bottom
// drawer. Desktop (>=768px): two columns — player table left, log+controls
// right (`max-w-3xl`, matching the spec's pinned layout convention).
import { Drawer } from "vaul";
import { useState } from "react";
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientRoomState } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import ConfirmDialog from "../../components/ConfirmDialog";
import HelpButton from "../../components/HelpButton";
import { forceAdvance, markAbsent, markPresent, reveal } from "../../store/gameStore";
import { forceAdvanceCopy, hostSeatRows, phaseLabel, phaseSummary } from "../../store/hostView";
import DeadlineCountdown from "./DeadlineCountdown";
import { PlayerTable } from "./PlayerTable";
import PrivacyChip from "./PrivacyChip";
import HostLog from "./HostLog";
import NarratorBoard from "./NarratorBoard";
import { legalBeatForPhase, StorytellerPanel, StorytellerSetupButton } from "./Storyteller";

function PhaseHeader({ game, rows }: { game: ClientGameView; rows: ReturnType<typeof hostSeatRows> }) {
  return (
    <Card className="gap-1 px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="file-heading text-xl text-bone" data-testid="host-phase-label">
          {phaseLabel(game.phase)} — Day {game.day}
        </p>
        <DeadlineCountdown deadlineAt={game.deadlineAt} />
      </div>
      <p className="text-sm text-smoke" data-testid="host-phase-summary">
        <span aria-hidden className="mr-1 select-none">
          //
        </span>
        {phaseSummary(game, rows)}
      </p>
    </Card>
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

// Spec 12 Feature 2: the narrator Reveal. Shown ONLY in sunrise/sunset (the
// engine rejects it anywhere else, `reveal_not_active`). The host narrates the
// scene aloud from the board, then taps this to resolve the deferred night/vote
// and continue to dawn/dusk. Captures phaseGen at click time; a stale gen is
// rejected `stale_advance` (the store toasts "already moved on"). No confirm
// dialog — this is the intended, expected beat, not a dangerous override.
function RevealControl({ game }: { game: ClientGameView }) {
  const isSunrise = game.phase === "sunrise";
  return (
    <div className="flex flex-col gap-2 rounded-sm border-2 border-brass/60 bg-ink-3 p-3">
      <p className="text-[0.65rem] uppercase tracking-[0.2em] text-brass-hi">
        {isSunrise ? "Set the morning scene" : "Set the evening scene"}
      </p>
      <p className="text-xs text-smoke">
        // Narrate what happens from the board below, then reveal it to the
        table. Players see a neutral holding screen until you do.
      </p>
      <Button
        type="button"
        data-testid="reveal-button"
        variant="brass"
        onClick={() => reveal(game.phaseGen)}
        className="w-full"
      >
        Reveal the scene
      </Button>
    </div>
  );
}

function Controls({ game }: { game: ClientGameView }) {
  const inScene = game.phase === "sunrise" || game.phase === "sunset";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">Investigator controls</p>
      {inScene && <RevealControl game={game} />}
      <ForceAdvanceControl game={game} />
      <p className="text-xs text-smoke">
        // Mark subjects absent/present from their row — absent subjects leave
        every consensus/vote denominator immediately.
      </p>
    </div>
  );
}

export default function HostGame({ room, game }: { room: ClientRoomState; game: ClientGameView }) {
  const rows = hostSeatRows(room);
  const playerNames = new Map(room.players.map((p) => [p.id, p.name]));
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <main className="safe-top safe-bottom safe-x relative z-10 mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 bg-ink p-4 text-paper">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <p className="text-[0.6rem] uppercase tracking-[0.3em] text-smoke">
            Lead investigator
          </p>
          <h1 className="file-heading text-xl text-blood">The Case Board</h1>
        </div>
        <div className="flex items-center gap-2">
          <StorytellerSetupButton story={room.story} />
          <HelpButton />
          <PrivacyChip />
        </div>
      </div>

      <PhaseHeader game={game} rows={rows} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-2">
          <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">Subject dossiers</p>
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
          <NarratorBoard game={game} rows={rows} playerNames={playerNames} />
          <StorytellerPanel story={room.story} legalBeat={legalBeatForPhase(game.phase)} phaseGen={game.phaseGen} />
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
              className="fixed bottom-0 left-0 right-0 z-50 mx-auto flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-lg border-t-2 border-frame bg-ink-2 p-6 shadow-card"
            >
              <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-frame" />
              <Drawer.Title asChild>
                <h2 className="file-heading text-xl text-bone">Investigator controls</h2>
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
