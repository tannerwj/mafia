// Night role-gated action drawer (D2). Bottom sheet (vaul) for
// target-selection actions — thumb reach on a phone held one-handed.
//
// Role-gated content, strictly from what `you.*` actually carries
// (src/shared/game-view.ts's `ClientGameView["you"]`, projected by
// src/engine/project.ts):
//   - mafia: target picker + `you.factionVotes` + `you.consensusReached`
//     (only present when `you.roleId`'s night action has `consensus:
//     "mafia"` AND phase is "night" — i.e. only for living mafia at night)
//     + `you.mafiaRoster` (partner knowledge, per Spec 02 v2.6).
//   - detective: target picker (excluding self — `targetRule:
//     "living-other"`) + `you.investigationResults` history.
//   - angel: target picker INCLUDING self (`targetRule: "living-any"`).
//   - minion: no `nightAction`, but `you.mafiaRoster` (Spec 02 v2.6) IS the
//     role's entire ability — rendered instead of the idle state.
//   - villager / suicide_bomber: no `nightAction` and no `mafiaRoster`, so
//     they get the idle "the town sleeps" state.
import { Drawer } from "vaul";
import { useState } from "react";
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientPlayerView } from "../../../shared/protocol";
import { submitAction } from "../../store/gameStore";

function TargetList({
  candidates,
  selectedId,
  onPick,
}: {
  candidates: { id: string; name: string }[];
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {candidates.map((c) => (
        <button
          key={c.id}
          type="button"
          data-testid="night-target-option"
          data-target-id={c.id}
          onClick={() => onPick(c.id)}
          className={`min-h-11 rounded-md border px-4 py-3 text-left transition-colors ${
            selectedId === c.id
              ? "border-brass bg-ink-3 text-brass"
              : "border-smoke bg-ink-2 text-bone"
          }`}
        >
          {c.name}
        </button>
      ))}
    </div>
  );
}

function IdleTownSleeps() {
  return (
    <div
      data-testid="night-idle"
      className="flex flex-col items-center gap-3 py-10 text-center"
    >
      <p className="font-display text-2xl text-bone">The town sleeps.</p>
      <p className="text-sm text-smoke">Nothing to do — wait for dawn.</p>
    </div>
  );
}

function MafiaRoster({
  mafiaRoster,
  playerNames,
}: {
  mafiaRoster: string[];
  playerNames: Map<string, string>;
}) {
  return (
    <div
      data-testid="mafia-roster"
      className="rounded-md border border-blood/60 bg-ink-3 p-3 text-sm"
    >
      <p className="mb-1 text-xs uppercase tracking-widest text-smoke">
        The Mafia
      </p>
      {mafiaRoster.length === 0 ? (
        <p className="text-bone/80">No one else is Mafia.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {mafiaRoster.map((id) => (
            <li key={id} className="text-blood">
              {playerNames.get(id) ?? id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MafiaNightPanel({
  you,
  players,
  playerNames,
}: {
  you: NonNullable<ClientGameView["you"]>;
  players: ClientGameView["players"];
  playerNames: Map<string, string>;
}) {
  const myTarget = you.pendingAction?.targetId ?? null;
  const candidates = players
    .filter((p) => p.alive && p.id !== you.playerId)
    .map((p) => ({ id: p.id, name: playerNames.get(p.id) ?? p.id }));

  // `you.factionVotes` (`state.mafiaVotes` filtered to killers) only
  // contains entries for partners who have ALREADY submitted a vote — it
  // starts empty and grows, so its own length undercounts the denominator
  // ("0 of 0 partners" when nobody has voted yet, instead of "0 of N").
  // `you.mafiaRoster` (Spec 02 v2.6) is the actual living-killer roster
  // (partners, self excluded) and is the correct denominator: total living
  // killers = roster + self.
  const totalKillers = (you.mafiaRoster?.length ?? 0) + 1;
  const votedCount = (you.factionVotes ?? []).filter((v) => v.targetId).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-smoke">Choose tonight's target.</p>
      <TargetList
        candidates={candidates}
        selectedId={myTarget}
        onPick={(id) => submitAction(id)}
      />
      <div
        data-testid="mafia-consensus"
        data-consensus-reached={you.consensusReached ?? false}
        className="rounded-md border border-smoke/60 bg-ink-3 p-3 text-sm"
      >
        <p className="text-smoke">
          {votedCount} of {totalKillers} partners have chosen.
        </p>
        <p className={you.consensusReached ? "text-brass" : "text-smoke"}>
          {you.consensusReached ? "Consensus reached." : "Awaiting consensus…"}
        </p>
      </div>
      {you.mafiaRoster && (
        <MafiaRoster mafiaRoster={you.mafiaRoster} playerNames={playerNames} />
      )}
    </div>
  );
}

function MinionNightPanel({
  mafiaRoster,
  playerNames,
}: {
  mafiaRoster: string[];
  playerNames: Map<string, string>;
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center" data-testid="minion-idle">
      <p className="font-display text-2xl text-bone">The town sleeps.</p>
      <p className="text-sm text-smoke">
        You have no action tonight — but you know who to protect.
      </p>
      <div className="w-full text-left">
        <MafiaRoster mafiaRoster={mafiaRoster} playerNames={playerNames} />
      </div>
    </div>
  );
}

function InvestigationHistory({
  results,
  playerNames,
}: {
  results: NonNullable<ClientGameView["you"]>["investigationResults"];
  playerNames: Map<string, string>;
}) {
  if (!results || results.length === 0) return null;
  return (
    <div
      data-testid="investigation-history"
      className="flex flex-col gap-1 rounded-md border border-smoke/60 bg-ink-3 p-3 text-sm"
    >
      <p className="mb-1 text-xs uppercase tracking-widest text-smoke">
        Your findings
      </p>
      {results.map((r) => (
        <p key={`${r.day}-${r.targetId}`}>
          Night {r.day}: {playerNames.get(r.targetId) ?? r.targetId} —{" "}
          <span className={r.isMafia ? "text-blood" : "text-bone"}>
            {r.isMafia ? "Mafia" : "Not mafia"}
          </span>
        </p>
      ))}
    </div>
  );
}

function DetectiveNightPanel({
  you,
  players,
  playerNames,
}: {
  you: NonNullable<ClientGameView["you"]>;
  players: ClientGameView["players"];
  playerNames: Map<string, string>;
}) {
  const myTarget = you.pendingAction?.targetId ?? null;
  const candidates = players
    .filter((p) => p.alive && p.id !== you.playerId)
    .map((p) => ({ id: p.id, name: playerNames.get(p.id) ?? p.id }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-smoke">Choose someone to investigate.</p>
      <TargetList
        candidates={candidates}
        selectedId={myTarget}
        onPick={(id) => submitAction(id)}
      />
      <InvestigationHistory results={you.investigationResults} playerNames={playerNames} />
    </div>
  );
}

function AngelNightPanel({
  you,
  players,
  playerNames,
}: {
  you: NonNullable<ClientGameView["you"]>;
  players: ClientGameView["players"];
  playerNames: Map<string, string>;
}) {
  const myTarget = you.pendingAction?.targetId ?? null;
  // Angel's targetRule is "living-any" — includes self.
  const candidates = players
    .filter((p) => p.alive)
    .map((p) => ({
      id: p.id,
      name:
        p.id === you.playerId
          ? `${playerNames.get(p.id) ?? p.id} (yourself)`
          : (playerNames.get(p.id) ?? p.id),
    }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-smoke">Choose someone to protect tonight.</p>
      <TargetList
        candidates={candidates}
        selectedId={myTarget}
        onPick={(id) => submitAction(id)}
      />
    </div>
  );
}

function WaitingOnSubmission({
  investigationResults,
  playerNames,
}: {
  investigationResults?: NonNullable<ClientGameView["you"]>["investigationResults"];
  playerNames?: Map<string, string>;
} = {}) {
  return (
    <div data-testid="night-submitted" className="flex flex-col items-center gap-4 py-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <p className="text-brass">Your choice is locked in.</p>
        <p className="text-sm text-smoke">Waiting for the night to end…</p>
      </div>
      {investigationResults && playerNames && (
        <div className="w-full text-left">
          <InvestigationHistory results={investigationResults} playerNames={playerNames} />
        </div>
      )}
    </div>
  );
}

export default function NightActionDrawer({
  game,
  players,
}: {
  game: ClientGameView;
  players: ClientPlayerView[];
}) {
  const [open, setOpen] = useState(true);
  const you = game.you;
  const playerNames = new Map(players.map((p) => [p.id, p.name]));

  if (!you || !you.alive) {
    return <IdleTownSleeps />;
  }

  const roleId = you.roleId;
  const hasNightRole = roleId === "mafia" || roleId === "detective" || roleId === "angel";

  // Minion has no `nightAction` (nothing to submit, no drawer to open) but
  // `you.mafiaRoster` (Spec 02 v2.6) IS the role's entire ability — render it
  // in place of the generic idle state instead of opening the vaul sheet.
  if (roleId === "minion" && you.mafiaRoster) {
    return <MinionNightPanel mafiaRoster={you.mafiaRoster} playerNames={playerNames} />;
  }

  if (!hasNightRole) {
    return <IdleTownSleeps />;
  }

  // Mafia's own submission still shows the consensus panel (not just a
  // "locked in" card) — that panel already IS the waiting state, since it
  // shows whether the group has landed on a target yet. Detective/angel
  // collapse to a plain "locked in" waiting card once they've submitted.
  const alreadySubmitted = you.pendingAction !== undefined;

  return (
    // `modal={false}`: Radix/vaul's default modal behavior sets
    // `pointer-events: none` on <body>, which would make the always-available
    // HoldToPeek affordance (rendered as a sibling, fixed-position, above
    // this drawer's z-index) genuinely unclickable while a night action is
    // pending — the spec pins hold-to-peek as reachable "for the rest of the
    // game", not suspended during your own night turn. `dismissible={false}`
    // still blocks swipe/backdrop-click dismissal of the drawer itself.
    <Drawer.Root open={open} onOpenChange={setOpen} dismissible={false} modal={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-ink/80" />
        <Drawer.Content
          data-testid="night-action-drawer"
          className="fixed bottom-0 left-0 right-0 z-50 mx-auto flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl border-t border-smoke bg-ink-2 p-6"
        >
          <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-smoke" />
          <Drawer.Title asChild>
            <h2 className="font-display text-2xl text-bone">Night falls</h2>
          </Drawer.Title>
          <Drawer.Description asChild>
            <span className="sr-only">
              Your night action for day {game.day}.
            </span>
          </Drawer.Description>

          <div className="safe-bottom mt-4 overflow-y-auto">
            {roleId === "mafia" && (
              <MafiaNightPanel you={you} players={game.players} playerNames={playerNames} />
            )}
            {roleId === "detective" &&
              (alreadySubmitted ? (
                <WaitingOnSubmission
                  investigationResults={you.investigationResults}
                  playerNames={playerNames}
                />
              ) : (
                <DetectiveNightPanel you={you} players={game.players} playerNames={playerNames} />
              ))}
            {roleId === "angel" &&
              (alreadySubmitted ? (
                <WaitingOnSubmission />
              ) : (
                <AngelNightPanel you={you} players={game.players} playerNames={playerNames} />
              ))}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
