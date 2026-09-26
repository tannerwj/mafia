// Top-level game router (D2/D3 glue): once `state.game !== null`, Room.tsx
// hands off to this component. Picks which screen to render purely from
// `game.phase` and `game.you` — a dead viewer (any phase) always gets the
// god view once the game has started, since a dead player's `you.alive` is
// false and the projection has already switched them into god mode
// server-side (the client isn't deciding privilege here, only which
// component matches what the projection already granted).
import { useEffect, useRef, useState } from "react";
import type { ClientGameView } from "../../../shared/game-view";
import type { ClientPlayerView } from "../../../shared/protocol";
import DayVoting from "./DayVoting";
import DeadGodView from "./DeadGodView";
import GameEnd from "./GameEnd";
import Interstitial from "./Interstitial";
import NightActionDrawer from "./NightActionDrawer";
import SceneHolding from "./SceneHolding";
import GameStatus from "./GameStatus";
import RoleReveal from "../../components/RoleReveal";
import MyRoleButton from "../../components/MyRoleButton";
import HelpButton from "../../components/HelpButton";

// The visible transition is "fade out, swap tint, fade in" — two sequential
// CSS opacity transitions (removing `data-tint="fading"` is itself an
// attribute change that retriggers the same `transition: opacity` rule for
// the fade-in leg). Each leg is half of the spec's pinned 300ms total
// transition budget, so the full out+in cycle lands at ~300ms, not 300ms
// per leg (~600ms total, which was the actual bug here — screens genuinely
// sat visibly dim for twice as long as the spec's pin, not "stuck").
const FADE_MS = 150;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}

// Spec 12 phase-discriminant audit: every Phase gets an explicit tint arm — no
// fallthrough. sunrise reads as the tail of night (cool), sunset as the tail of
// day (warm), matching the neighbouring resolved beat's mood.
function tintFor(phase: ClientGameView["phase"]): "night" | "day" {
  switch (phase) {
    case "day":
    case "runoff":
    case "sunset":
    case "dusk":
      return "day";
    case "night":
    case "sunrise":
    case "dawn":
    case "ended":
      return "night";
  }
}

/** Cool/pure-ink at night, warm ink-2+brass by day — the phase-tint
 * mechanism pinned in D1. The fade is a 300ms opacity transition that is
 * always interruptible: a newer snapshot arriving mid-fade just re-renders
 * immediately, it never queues or delays newer state.
 *
 * Driven by `phaseGen` (the engine's own monotonic transition counter,
 * bumped exactly once per phase change) rather than a manually-timed
 * `fading` boolean: two phase changes arriving close together (e.g. a
 * timed dusk beat expiring right as the next snapshot lands) could
 * previously race two independent `setTimeout`s against each other and,
 * on an unlucky interleaving, leave a stale timeout's `setFading(false)`
 * clearing the fade state before the browser's own opacity transition had
 * actually reached 1 — the CSS transition would then have no further
 * attribute change to resume from, stranding it at whatever partial
 * opacity it was interrupted at. `phaseGen` sidesteps this: `fading` is
 * *derived* (true iff the fade-out for the current `gen` hasn't finished),
 * so every fade started for a given `gen` reliably clears by that same
 * `gen`'s timeout, and a newer `gen` starting mid-fade is always the one
 * that wins — there is nothing left to interrupt a resolved timer with. */
function usePhaseTint(phase: ClientGameView["phase"], phaseGen: number) {
  const [tint, setTint] = useState<"night" | "day">(tintFor(phase));
  const [fadingGen, setFadingGen] = useState<number | null>(null);
  const lastGenRef = useRef(phaseGen);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const next = tintFor(phase);
    if (lastGenRef.current === phaseGen) {
      // If the OS preference changes during an in-flight fade, cancel the
      // fade immediately. Otherwise the `data-tint="fading"` opacity state
      // can leave the screen blank until the 150ms timer expires even though
      // reduced motion explicitly disables the CSS transition.
      if (reducedMotion) {
        setTint(next);
        setFadingGen(null);
      }
      return;
    }
    lastGenRef.current = phaseGen;

    // Reduced-motion users should never see the intermediate blank state.
    // Apply the new phase tint in the same render cycle and skip the timer.
    if (reducedMotion) {
      setTint(next);
      setFadingGen(null);
      return;
    }

    setFadingGen(phaseGen);
    const t = setTimeout(() => {
      setTint(next);
      // Only clear the fade if nothing newer has started since — a stale
      // timer from an older `gen` must never clobber a fresher fade.
      setFadingGen((current) => (current === phaseGen ? null : current));
    }, FADE_MS);
    return () => clearTimeout(t);
  }, [phase, phaseGen, reducedMotion]);

  return { tint, fading: fadingGen !== null };
}

function phaseHeading(phase: ClientGameView["phase"]): string {
  switch (phase) {
    case "night":
      return "Night falls";
    case "sunrise":
      return "Morning scene";
    case "dawn":
      return "Morning report";
    case "day":
      return "Town decision";
    case "runoff":
      return "Runoff";
    case "sunset":
      return "Evening scene";
    case "dusk":
      return "Nightfall report";
    case "ended":
      return "Case closed";
  }
}

function phaseTask(phase: ClientGameView["phase"], isDead: boolean, acknowledged: boolean): string {
  if (isDead) return "Watch the room. Your file now shows resolved events only.";
  switch (phase) {
    case "night":
      return "Complete your private action, then lock it in.";
    case "sunrise":
    case "sunset":
      return "Listen to the host's scene reveal.";
    case "dawn":
      return acknowledged ? "Your report is acknowledged. Waiting for the room." : "Read the report, then continue.";
    case "day":
    case "runoff":
      return "Choose a living suspect, then confirm your vote.";
    case "dusk":
      return "The host is closing the vote. Stay with the table.";
    case "ended":
      return "Review the verdict and the unsealed roles.";
  }
}

function phaseStatus(phase: ClientGameView["phase"], isDead: boolean): string {
  if (isDead) return "Out of play";
  if (phase === "night" || phase === "day" || phase === "runoff") return "Your move";
  if (phase === "ended") return "Resolved";
  return "Stay with table";
}

function GameMomentHeader({ game, isDead }: { game: ClientGameView; isDead: boolean }) {
  const acknowledged = game.you?.acknowledged ?? false;
  return (
    <header
      data-testid="game-moment"
      className="mx-auto w-full max-w-md px-4 pb-3"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3 border-b border-frame/70 pb-3">
        <div className="min-w-0">
          <p className="text-[0.62rem] uppercase tracking-[0.28em] text-smoke">
            File day {game.day} · {isDead ? "Spectator" : game.phase}
          </p>
          <p className="file-heading mt-1 truncate text-xl text-bone">
            {phaseHeading(game.phase)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-sm border px-2 py-1 text-[0.6rem] font-bold uppercase tracking-[0.12em] ${
            isDead ? "border-blood/60 text-blood-hi" : "border-brass/60 text-brass-hi"
          }`}
        >
          {phaseStatus(game.phase, isDead)}
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-paper/80">{phaseTask(game.phase, isDead, acknowledged)}</p>
    </header>
  );
}

export default function GameScreen({
  game,
  players,
  isHost,
}: {
  game: ClientGameView;
  players: ClientPlayerView[];
  isHost: boolean;
}) {
  const { tint, fading } = usePhaseTint(game.phase, game.phaseGen);
  const you = game.you;
  const isDead = you !== undefined && !you.alive;

  return (
    <main
      data-testid="game-screen"
      data-phase={game.phase}
      className="phase-tint safe-pt safe-pb safe-px relative mx-auto flex min-h-dvh w-full max-w-md flex-col text-bone"
      data-tint={fading ? "fading" : tint}
    >
      {/* Decorative phase wash (Spec 09 D1) — CSS keyed off this <main>'s
          existing data-phase. Absolute, pointer-events:none, z-0, so it sits
          behind interactive content and never delays newer state. */}
      <div className="phase-ambiance" aria-hidden="true" />
      {you && <RoleReveal roleId={you.roleId ?? ""} />}
      {you?.roleId && (
        <MyRoleButton
          roleId={you.roleId}
          mafiaRoster={you.mafiaRoster}
          playerNames={new Map(players.map((p) => [p.id, p.name]))}
          investigationResults={you.investigationResults}
        />
      )}
      <HelpButton className="chip-inset-br fixed z-60 flex h-11 w-11 items-center justify-center rounded-sm border-2 border-frame bg-ink-2 text-lg text-paper shadow-lg" />

      {/* Spec 12 Feature 3: the always-available all-player status panel. Shown
          for every in-game player screen (living or dead) except the end
          screen, which has its own full role reveal. */}
      {game.phase !== "ended" && (
        <GameStatus game={game} playerNames={new Map(players.map((p) => [p.id, p.name]))} />
      )}

      {/* Content stacks above the decorative z-0 ambiance wash. */}
      <div className="relative z-10 flex flex-1 flex-col pt-16">
        <GameMomentHeader game={game} isDead={isDead} />
        {game.phase === "ended" ? (
          <GameEnd game={game} players={players} isHost={isHost} />
        ) : game.phase === "sunrise" || game.phase === "sunset" ? (
          // Spec 12: the deferred-resolution holding screen. Placed BEFORE the
          // isDead branch: during sunrise/sunset the night/vote is UNRESOLVED,
          // so a would-be-dead player is still projected alive and must see the
          // neutral holding screen, never a god view that would leak the pending
          // outcome. Everyone (would-be living or dead) waits here.
          <SceneHolding game={game} />
        ) : isDead ? (
          <DeadGodView game={game} players={players} />
        ) : game.phase === "dawn" || game.phase === "dusk" ? (
          <Interstitial
            game={game}
            playerNames={new Map(players.map((p) => [p.id, p.name]))}
          />
        ) : game.phase === "night" ? (
          <NightActionDrawer game={game} players={players} />
        ) : (
          <DayVoting game={game} players={players} />
        )}
      </div>
    </main>
  );
}
