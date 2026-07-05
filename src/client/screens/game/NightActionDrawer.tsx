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
import { lockAction, submitAction, unlockAction } from "../../store/gameStore";
import { Redaction } from "../../components/ui/dossier";

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
      {candidates.map((c, i) => {
        const selected = selectedId === c.id;
        return (
          <button
            key={c.id}
            type="button"
            data-testid="night-target-option"
            data-target-id={c.id}
            onClick={() => onPick(c.id)}
            // NOTE: the selected state keeps `border-brass` — the reconnect
            // E2E asserts `toHaveClass(/border-brass/)` on the restored pick.
            className={`flex min-h-11 items-center gap-3 rounded-sm border px-4 py-3 text-left transition-colors ${
              selected
                ? "border-brass bg-ink-3 text-brass-hi"
                : "border-frame bg-ink-2 text-paper"
            }`}
          >
            <span className="text-xs tabular-nums text-smoke">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="flex-1">{c.name}</span>
            {selected && (
              <span aria-hidden className="text-[0.6rem] uppercase tracking-[0.15em] text-blood">
                marked
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function IdleTownSleeps() {
  return (
    <div
      data-testid="night-idle"
      className="flex flex-col items-center gap-3 py-10 text-center"
    >
      <p className="file-heading text-2xl text-bone">The town sleeps</p>
      <p className="text-sm text-smoke">// no action tonight — wait for dawn.</p>
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
      className="rounded-sm border border-blood/60 bg-ink-3 p-3 text-sm"
    >
      <p className="mb-1 text-[0.65rem] uppercase tracking-[0.15em] text-smoke">
        The Syndicate
      </p>
      {mafiaRoster.length === 0 ? (
        <p className="text-paper/80">No known associates.</p>
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

function TeammatePicks({
  factionVotes,
  you,
  playerNames,
}: {
  factionVotes: NonNullable<NonNullable<ClientGameView["you"]>["factionVotes"]>;
  you: NonNullable<ClientGameView["you"]>;
  playerNames: Map<string, string>;
}) {
  return (
    <div
      data-testid="mafia-teammate-picks"
      className="flex flex-col gap-1 rounded-sm border border-frame bg-ink-3 p-3 text-sm"
    >
      <p className="mb-1 text-[0.65rem] uppercase tracking-[0.15em] text-smoke">
        Syndicate marks tonight
      </p>
      <ul className="flex flex-col gap-1">
        {factionVotes.map((v) => {
          const isYou = v.voterId === you.playerId;
          const targetName = v.targetId
            ? (playerNames.get(v.targetId) ?? v.targetId)
            : null;
          return (
            <li
              key={v.voterId}
              data-testid="mafia-teammate-pick"
              data-voter-id={v.voterId}
              data-target-id={v.targetId ?? ""}
              data-locked={v.locked}
              className="flex items-center justify-between gap-2"
            >
              <span className="text-paper">
                {isYou ? "You" : (playerNames.get(v.voterId) ?? v.voterId)}
              </span>
              {targetName ? (
                <span className="text-paper/80">
                  {targetName}{" "}
                  {v.locked ? (
                    <span aria-hidden className="text-brass-hi">
                      ✓ locked
                    </span>
                  ) : (
                    <span className="text-smoke">(tentative)</span>
                  )}
                </span>
              ) : (
                // Undecided teammate → a redaction bar over the unknown mark,
                // with the honest "deciding…" label the mafia see live.
                <span className="flex items-center gap-2 text-smoke italic">
                  <Redaction width="3.5rem" label="undecided" />
                  deciding…
                </span>
              )}
            </li>
          );
        })}
      </ul>
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
  const factionVotes = you.factionVotes ?? [];
  const myVote = factionVotes.find((v) => v.voterId === you.playerId);
  const iAmLocked = myVote?.locked ?? false;
  const candidates = players
    .filter((p) => p.alive && p.id !== you.playerId)
    .map((p) => ({ id: p.id, name: playerNames.get(p.id) ?? p.id }));

  // `factionVotes` (Spec 08) covers every living, non-absent killer
  // (including self) — its length IS the total killer count, never a
  // picked-count proxy.
  const totalKillers = factionVotes.length;
  const lockedCount = you.lockedCount ?? factionVotes.filter((v) => v.locked).length;
  const allLocked = totalKillers > 0 && lockedCount === totalKillers;
  const statusText = you.consensusReached
    ? "Order confirmed."
    : allLocked
      ? "Everyone's locked in, but your marks disagree — keep deciding."
      : `${lockedCount} of ${totalKillers} locked · waiting…`;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-smoke">// mark one suspect for tonight.</p>
      <TargetList
        candidates={candidates}
        selectedId={myTarget}
        onPick={(id) => submitAction(id)}
      />
      <button
        type="button"
        data-testid="lock-in-button"
        disabled={!myTarget}
        onClick={() => (iAmLocked ? unlockAction() : lockAction())}
        className={`min-h-11 rounded-sm border px-4 py-3 text-sm font-bold uppercase tracking-[0.1em] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          iAmLocked
            ? "border-brass bg-ink-3 text-brass-hi"
            : "border-frame bg-ink-2 text-paper"
        }`}
      >
        {iAmLocked ? "Unlock" : "Lock in"}
      </button>
      <div
        data-testid="mafia-consensus"
        data-consensus-reached={you.consensusReached ?? false}
        data-locked-count={lockedCount}
        data-total-killers={totalKillers}
        className={`rounded-sm border bg-ink-3 p-3 text-sm ${
          you.consensusReached
            ? "animate-brass-pulse border-brass/60"
            : "border-frame"
        }`}
      >
        <p className={you.consensusReached ? "text-brass-hi" : "text-smoke"}>
          {statusText}
        </p>
      </div>
      <TeammatePicks factionVotes={factionVotes} you={you} playerNames={playerNames} />
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
      <p className="file-heading text-2xl text-bone">The town sleeps</p>
      <p className="text-sm text-smoke">
        // no action tonight — but you know the syndicate.
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
      className="flex flex-col gap-1 rounded-sm border border-frame bg-ink-3 p-3 text-sm"
    >
      <p className="mb-1 text-[0.65rem] uppercase tracking-[0.15em] text-smoke">
        Case findings
      </p>
      {results.map((r) => (
        <p key={`${r.day}-${r.targetId}`}>
          Night {r.day}: {playerNames.get(r.targetId) ?? r.targetId} —{" "}
          <span className={r.isMafia ? "text-blood" : "text-paper"}>
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
      <p className="text-sm text-smoke">// pull one subject's file to investigate.</p>
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
      <p className="text-sm text-smoke">// place one subject under protection tonight.</p>
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
        <span className="stamp stamp-olive text-[0.6rem]">Filed</span>
        <p className="text-sm text-smoke">// waiting for the night to close…</p>
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

  const drawerTitle =
    roleId === "mafia"
      ? "Who dies tonight?"
      : roleId === "detective"
        ? "Night interrogation"
        : "Protective detail";

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
          className="fixed bottom-0 left-0 right-0 z-50 mx-auto flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-lg border-t-2 border-frame bg-ink-2 p-6 shadow-card"
        >
          <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-frame" />
          <p className="text-[0.6rem] uppercase tracking-[0.35em] text-smoke">
            After dark · File Day {game.day}
          </p>
          <Drawer.Title asChild>
            <h2 className="file-heading mt-1 text-2xl text-bone">{drawerTitle}</h2>
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
