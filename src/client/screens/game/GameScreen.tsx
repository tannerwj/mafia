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

function tintFor(phase: ClientGameView["phase"]): "night" | "day" {
  return phase === "day" || phase === "dusk" || phase === "runoff" ? "day" : "night";
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

  useEffect(() => {
    if (lastGenRef.current === phaseGen) return;
    lastGenRef.current = phaseGen;
    setFadingGen(phaseGen);
    const next = tintFor(phase);
    const t = setTimeout(() => {
      setTint(next);
      // Only clear the fade if nothing newer has started since — a stale
      // timer from an older `gen` must never clobber a fresher fade.
      setFadingGen((current) => (current === phaseGen ? null : current));
    }, FADE_MS);
    return () => clearTimeout(t);
  }, [phase, phaseGen]);

  return { tint, fading: fadingGen !== null };
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
      className="phase-tint safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-md flex-col text-bone"
      data-tint={fading ? "fading" : tint}
    >
      {you && <RoleReveal roleId={you.roleId ?? ""} />}
      {you?.roleId && (
        <MyRoleButton
          roleId={you.roleId}
          mafiaRoster={you.mafiaRoster}
          playerNames={new Map(players.map((p) => [p.id, p.name]))}
        />
      )}
      <HelpButton className="fixed bottom-3 right-3 z-60 flex h-11 w-11 items-center justify-center rounded-full border-2 border-smoke bg-ink-2 text-lg text-bone shadow-lg safe-bottom safe-x" />

      {game.phase === "ended" ? (
        <GameEnd game={game} players={players} isHost={isHost} />
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
    </main>
  );
}
