// Full unredacted log (D1) — the host projection's `log` is the live case file
// (no hidden-vote filtering or action stripping; player/public projections use
// an explicit safe allowlist in src/engine/project.ts). This renders
// every event as plain text, auto-scrolling to the latest entry unless the
// host has scrolled up to read history ("pin-to-latest").
import { useEffect, useRef, useState } from "react";
import type { ClientGameView, GameEvent } from "../../../shared/game-view";

function describe(event: GameEvent, names: Map<string, string>): string {
  const name = (id: string) => names.get(id) ?? id;
  switch (event.type) {
    case "gameStarted":
      return `Game started. Roles assigned: ${event.roleAssignments
        .map((r) => `${name(r.playerId)}=${r.roleId}`)
        .join(", ")}`;
    case "phaseChanged":
      return `Phase -> ${event.phase} (day ${event.day})`;
    case "actionSubmitted":
      return `${name(event.actorId)} submitted ${event.actionType}${event.targetId ? ` -> ${name(event.targetId)}` : ""}`;
    case "actionLocked":
      return `${name(event.actorId)} locked in their pick`;
    case "actionUnlocked":
      return `${name(event.actorId)} unlocked their pick`;
    case "voteCast":
      return `${name(event.voterId)} voted for ${event.target === "no_murder" ? "no murder" : name(event.target)}`;
    case "voteRetracted":
      return `${name(event.voterId)} retracted their vote`;
    case "voteLocked":
      return `${name(event.voterId)} confirmed their vote`;
    case "voteUnlocked":
      return `${name(event.voterId)} unconfirmed their vote`;
    case "acknowledged":
      return `${name(event.playerId)} acknowledged the morning report`;
    case "attackAttempted":
      return `Attack on ${name(event.targetId)} by ${name(event.actorId)}: ${event.outcome} (${event.attack} vs ${event.defense})`;
    case "playerDied":
      return `${name(event.playerId)} died (${event.roleId}, cause: ${event.cause})`;
    case "investigationResult":
      return `${name(event.actorId)} investigated ${name(event.targetId)}: ${event.isMafia ? "mafia" : "not mafia"}`;
    case "runoffStarted":
      return `Runoff started: ${event.candidates.map(name).join(" vs ")}`;
    case "voteResolved":
      return event.eliminatedId
        ? `Vote resolved: ${name(event.eliminatedId)} eliminated`
        : `Vote resolved: no elimination (${event.reason})`;
    case "playerAbsent":
      return `${name(event.playerId)} marked absent`;
    case "playerPresent":
      return `${name(event.playerId)} marked present`;
    case "gameEnded":
      return `Game ended: ${event.winners.join(", ")} win (${event.reason})`;
  }
}

export default function HostLog({
  game,
  playerNames,
}: {
  game: ClientGameView;
  playerNames: Map<string, string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    if (!pinned || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [game.log.length, pinned]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setPinned(atBottom);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">Case log</p>
        {!pinned && (
          <button
            type="button"
            data-testid="log-jump-latest"
            onClick={() => {
              setPinned(true);
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
            }}
            className="text-xs text-brass-hi underline"
          >
            Jump to latest
          </button>
        )}
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="host-log"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-sm border border-frame bg-ink-3 p-3 text-sm text-paper/80"
      >
        {game.log.length === 0 ? (
          <p className="text-smoke">// nothing on file yet.</p>
        ) : (
          game.log.map((event, i) => (
            <p key={i} data-testid="host-log-line">
              {describe(event, playerNames)}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
