// Night action drawer (D3, Spec 11): EVERY living player performs the same
// pick→confirm shape — real roles do their real thing, no-action roles pick a
// living player to "keep an eye on" (the inert decoy `"watch"`). This kills
// the "only power roles tap / only mafia lock" tell: villager, minion, and
// bomber now open the same drawer, pick, and confirm just like a detective.
//
// Content is strictly what `you.*` carries (src/engine/project.ts):
//   - mafia: MafiaNightPanel — target picker + `factionVotes`/`consensusReached`
//     + roster + the mafia consensus lock-in.
//   - detective: picker (living-other) + private findings live in the role
//     card now (Spec 11 2b), not here.
//   - angel: picker (living-any, incl. self).
//   - decoy (`you.nightIsDecoy`): "keep an eye on someone" picker — villager /
//     minion / bomber. Minion also sees the syndicate roster.
// All of detective/angel/decoy share one IndividualNightPanel: pick (submit),
// then a "Confirm" that locks the pick (`lockAction`); "Change pick" unlocks.
import { Drawer } from "vaul";
import { useState } from "react";
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientPlayerView } from "../../../shared/protocol";
import { lockAction, submitAction, unlockAction } from "../../store/gameStore";
import { Redaction } from "../../components/ui/dossier";

function TargetList({
  candidates,
  selectedId,
  disabled,
  testid,
  onPick,
}: {
  candidates: { id: string; name: string }[];
  selectedId: string | null;
  disabled?: boolean;
  testid: string;
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
            data-testid={testid}
            data-target-id={c.id}
            disabled={disabled}
            onClick={() => onPick(c.id)}
            // NOTE: the selected state keeps `border-brass` — the reconnect
            // E2E asserts `toHaveClass(/border-brass/)` on the restored pick.
            className={`flex min-h-11 items-center gap-3 rounded-sm border px-4 py-3 text-left transition-colors disabled:opacity-60 ${
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
      <p className="text-sm text-smoke">// wait for dawn.</p>
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
        testid="night-target-option"
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

/** The shared pick→confirm panel for every non-mafia living player: detective,
 * angel, AND the decoy roles (villager/minion/bomber). Same shape everywhere
 * (Spec 11 anti-metagaming) — pick a living target, then confirm to lock it;
 * "Change pick" unlocks. Confirm uses the generic `lockAction`/`unlockAction`
 * (the engine locks whichever night input this player owes). */
function IndividualNightPanel({
  you,
  players,
  playerNames,
  prompt,
  includeSelf,
  extra,
}: {
  you: NonNullable<ClientGameView["you"]>;
  players: ClientGameView["players"];
  playerNames: Map<string, string>;
  prompt: string;
  includeSelf: boolean;
  extra?: React.ReactNode;
}) {
  const myTarget = you.pendingAction?.targetId ?? null;
  const locked = you.nightActionLocked ?? false;
  const candidates = players
    .filter((p) => p.alive && (includeSelf || p.id !== you.playerId))
    .map((p) => ({
      id: p.id,
      name:
        includeSelf && p.id === you.playerId
          ? `${playerNames.get(p.id) ?? p.id} (yourself)`
          : (playerNames.get(p.id) ?? p.id),
    }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-smoke">// {prompt}</p>
      <TargetList
        candidates={candidates}
        selectedId={myTarget}
        disabled={locked}
        // Decoy roles get their own testid so a parity test can assert the
        // "keep an eye on someone" picker exists; real roles keep
        // `night-target-option` (the E2E clicks it by name).
        testid={you.nightIsDecoy ? "night-watch-option" : "night-target-option"}
        onPick={(id) => submitAction(id)}
      />
      {locked ? (
        <div className="flex flex-col gap-2">
          <div
            data-testid="night-submitted"
            className="animate-brass-pulse rounded-sm border border-brass/60 bg-ink-3 p-3 text-center text-sm text-brass-hi"
          >
            Locked in. Waiting for the night to close…
          </div>
          <button
            type="button"
            data-testid="night-unconfirm-button"
            onClick={() => unlockAction()}
            className="min-h-11 text-sm text-smoke underline"
          >
            Change pick
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="night-confirm-button"
          disabled={!myTarget}
          onClick={() => lockAction()}
          className="min-h-11 rounded-sm border-2 border-brass bg-ink-3 px-4 py-3 text-sm font-bold uppercase tracking-[0.1em] text-brass-hi transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          Confirm
        </button>
      )}
      {extra}
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
  const isMafia = roleId === "mafia";
  const isDecoy = you.nightIsDecoy ?? false;

  const drawerTitle = isMafia
    ? "Who dies tonight?"
    : roleId === "detective"
      ? "Night interrogation"
      : roleId === "angel"
        ? "Protective detail"
        : "Keep watch";

  return (
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
            <span className="sr-only">Your night action for day {game.day}.</span>
          </Drawer.Description>

          <div className="safe-pb mt-4 overflow-y-auto">
            {isMafia ? (
              <MafiaNightPanel you={you} players={game.players} playerNames={playerNames} />
            ) : isDecoy ? (
              <IndividualNightPanel
                you={you}
                players={game.players}
                playerNames={playerNames}
                prompt="keep an eye on someone tonight."
                includeSelf={false}
                extra={
                  you.mafiaRoster ? (
                    <MafiaRoster mafiaRoster={you.mafiaRoster} playerNames={playerNames} />
                  ) : undefined
                }
              />
            ) : roleId === "detective" ? (
              <IndividualNightPanel
                you={you}
                players={game.players}
                playerNames={playerNames}
                prompt="pull one subject's file to investigate."
                includeSelf={false}
              />
            ) : (
              <IndividualNightPanel
                you={you}
                players={game.players}
                playerNames={playerNames}
                prompt="place one subject under protection tonight."
                includeSelf={true}
              />
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
