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

function nextActionCopy(game: ClientGameView, rows: ReturnType<typeof hostSeatRows>): string {
  const active = rows.filter((row) => row.alive && !row.absent);
  if (game.phase === "night") {
    const pending = active.filter((row) => row.status.kind === "pending").length;
    return pending > 0
      ? "Let players finish their private action. Force advance if the table is stalled."
      : "The room is ready for the night to resolve.";
  }
  if (game.phase === "day" || game.phase === "runoff") {
    const pending = active.filter((row) => row.status.kind === "not-voted").length;
    return pending > 0
      ? "Let players confirm their ballots. Force advance if the table is stalled."
      : "The room is ready for the vote to resolve.";
  }
  if (game.phase === "sunrise" || game.phase === "sunset") {
    return "Narrate the scene aloud, then tap Reveal when the table is ready.";
  }
  if (game.phase === "dawn" || game.phase === "dusk") {
    return "Let the report beat finish, or force advance if someone is waiting.";
  }
  return "Review the verdict, then open a rematch when the table is ready.";
}

function PhaseProgress({ game, rows }: { game: ClientGameView; rows: ReturnType<typeof hostSeatRows> }) {
  const active = rows.filter((row) => row.alive && !row.absent);
  const actors = active.filter((row) => row.status.kind === "acted" || row.status.kind === "pending");
  const voters = active.filter((row) => row.status.kind === "voted" || row.status.kind === "not-voted");
  const isNight = game.phase === "night";
  const isVoting = game.phase === "day" || game.phase === "runoff";
  const total = isNight ? actors.length : isVoting ? voters.length : 1;
  const done = isNight
    ? actors.filter((row) => row.status.kind === "acted").length
    : isVoting
      ? voters.filter((row) => row.status.kind === "voted").length
      : game.phase === "sunrise" || game.phase === "sunset"
        ? 0
        : 1;
  const label = isNight
    ? `${done} of ${total} actions complete`
    : isVoting
      ? `${done} of ${total} ballots confirmed`
      : game.phase === "sunrise" || game.phase === "sunset"
        ? "Host reveal pending"
        : "Scene beat in progress";

  return (
    <div data-testid="host-next-action" className="mt-3 rounded-sm border border-brass/40 bg-ink-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-brass-hi">Next action</p>
        <p className="text-right text-xs tabular-nums text-smoke">{label}</p>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-paper/80">{nextActionCopy(game, rows)}</p>
      {total > 1 && (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <div
            className="h-full rounded-full bg-brass transition-[width] duration-300"
            style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function PhaseHeader({ game, rows }: { game: ClientGameView; rows: ReturnType<typeof hostSeatRows> }) {
  return (
    <Card className="gap-1 px-4 py-3">
      <div className="flex items-center justify-between">
        <p
          className="file-heading text-xl text-bone"
          data-testid="host-phase-label"
          aria-live="polite"
          aria-atomic="true"
        >
          {phaseLabel(game.phase)} — Day {game.day}
        </p>
        <span aria-live="off">
          <DeadlineCountdown deadlineAt={game.deadlineAt} />
        </span>
      </div>
      <p className="text-sm text-smoke" data-testid="host-phase-summary">
        <span aria-hidden className="mr-1 select-none">
          //
        </span>
        {phaseSummary(game, rows)}
      </p>
      <PhaseProgress game={game} rows={rows} />
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
    <main className="page-p-sm relative z-10 mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 bg-ink text-paper">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
        <div className="flex flex-col">
          <p className="text-[0.6rem] uppercase tracking-[0.3em] text-smoke">
            Lead investigator
          </p>
          <h1 className="file-heading text-xl text-blood-hi">The Case Board</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          Host controls
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
              <div className="safe-pb mt-4 overflow-y-auto">
                <Controls game={game} />
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      </div>
    </main>
  );
}
