// HostLobby (D1): restyle of Spec 01's functional lobby — player list +
// presence, kick, large room code + share, start button with a player-count
// gate and a HOUSE_RULES summary card. Player screens (Lobby.tsx) are
// untouched — this is a separate component for the host identity only.
import type { ClientRoomState } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import HelpButton from "../../components/HelpButton";
import { HOUSE_RULESET } from "../../lib/houseRuleset";
import { HOUSE_RULES, validateRuleset } from "../../../engine";
import { hostSeatRows } from "../../store/hostView";
import { PlayerTable } from "./PlayerTable";
import PrivacyChip from "./PrivacyChip";

// Smallest player count that clears validation for the house ruleset. Probed
// (not hardcoded) so this stays honest if the ruleset's fixed role counts
// change — the previous hardcoded `MIN_PLAYERS = 3` was wrong for HOUSE_RULES
// (needs >=5), producing an enabled "Start game" that failed server-side
// validation with a confusing role_count_mismatch error.
function minPlayersForHouse(): number {
  for (let n = 1; n <= 20; n++) {
    if (validateRuleset(HOUSE_RULES, n).errors.length === 0) return n;
  }
  return 20;
}

function HouseRulesSummary() {
  const r = HOUSE_RULESET;
  return (
    <div
      data-testid="house-rules-summary"
      className="w-full rounded-md border border-smoke/60 bg-ink-3 p-4 text-sm text-bone/80"
    >
      <p className="mb-2 font-display text-lg text-bone">House rules</p>
      <ul className="flex flex-col gap-1">
        <li>Mafia count: auto ({r.mafiaCountFormula})</li>
        <li>Detective, Angel, Suicide Bomber: 1 each</li>
        <li>Tie policy: {r.tiePolicy}</li>
        <li>Vote threshold: {r.dayVoteThreshold}</li>
        <li>Mafia consensus: {r.mafiaConsensus}</li>
        <li>Reveal on death: {r.revealOnDeath}</li>
        <li>Voting visibility: {r.votingVisibility}</li>
        <li>Timers: untimed (no timer config set)</li>
      </ul>
    </div>
  );
}

export default function HostLobby({
  state,
  onKick,
  onCopyLink,
  onStartGame,
}: {
  state: ClientRoomState;
  onKick: (playerId: string) => void;
  onCopyLink: () => void;
  onStartGame: () => void;
}) {
  const rows = hostSeatRows(state);
  // Honest start gate: mirror the server's own check. The host is a pure
  // arbitrator (not a player), so state.players.length is the real seat count
  // start_game will validate against.
  const canStart = validateRuleset(HOUSE_RULES, state.players.length).errors.length === 0;
  const minPlayers = minPlayersForHouse();

  return (
    <main className="safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center gap-6 bg-ink p-6 text-bone">
      <div className="flex w-full items-center justify-between gap-2">
        <h1 className="font-display text-3xl text-blood">Host console</h1>
        <div className="flex items-center gap-2">
          <HelpButton />
          <PrivacyChip />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span
          data-testid="room-code"
          className="rounded-md border border-smoke bg-ink-2 px-6 py-3 text-3xl tracking-widest text-brass"
        >
          {state.roomCode}
        </span>
        <Button type="button" data-testid="copy-link" onClick={onCopyLink} variant="outline">
          Share link
        </Button>
      </div>

      <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <p className="text-xs uppercase tracking-widest text-smoke">
            Players ({state.players.length})
          </p>
          <PlayerTable rows={rows} inGame={false} lobbyMode onKick={onKick} />
        </div>

        <div className="flex flex-col gap-4">
          <HouseRulesSummary />
          <Button
            type="button"
            data-testid="start-game"
            onClick={onStartGame}
            disabled={!canStart}
            size="lg"
            variant="brass"
            className="w-full"
          >
            {canStart ? "Start game" : `Need at least ${minPlayers} players`}
          </Button>
        </div>
      </div>
    </main>
  );
}
