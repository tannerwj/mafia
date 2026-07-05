// HostLobby (D1): restyle of Spec 01's functional lobby — player list +
// presence, kick, large room code + share, start button with a player-count
// gate and a HOUSE_RULES summary card. Player screens (Lobby.tsx) are
// untouched — this is a separate component for the host identity only.
import type { ClientRoomState } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { FieldRow, Stamp } from "../../components/ui/dossier";
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
    <Card data-testid="house-rules-summary" className="w-full bg-ink-3">
      <CardHeader className="pb-2">
        <CardTitle>Case parameters</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 pb-4 text-sm text-paper/80">
        <FieldRow label="Mafia count" value={`auto (${r.mafiaCountFormula})`} />
        <FieldRow label="Detective / Angel / Bomber" value="1 each" />
        <FieldRow label="Tie policy" value={r.tiePolicy} />
        <FieldRow label="Vote threshold" value={r.dayVoteThreshold} />
        <FieldRow label="Mafia consensus" value={r.mafiaConsensus} />
        <FieldRow label="Reveal on death" value={r.revealOnDeath} />
        <FieldRow label="Voting visibility" value={r.votingVisibility} />
        <FieldRow label="Timers" value="untimed" />
      </CardContent>
    </Card>
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
    <main className="safe-top safe-bottom safe-x relative z-10 mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center gap-6 bg-ink p-6 text-paper">
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <p className="text-[0.6rem] uppercase tracking-[0.3em] text-smoke">
              Lead investigator
            </p>
            <h1 className="file-heading text-2xl text-blood">The Case Room</h1>
          </div>
          <Stamp variant="confidential" className="hidden text-[0.6rem] sm:inline-flex" />
        </div>
        <div className="flex items-center gap-2">
          <HelpButton />
          <PrivacyChip />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span
          data-testid="room-code"
          className="rounded-sm border border-frame bg-ink-2 px-6 py-3 text-3xl tracking-[0.3em] text-brass-hi"
        >
          {state.roomCode}
        </span>
        <Button type="button" data-testid="copy-link" onClick={onCopyLink} variant="outline">
          Share link
        </Button>
      </div>

      <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
            Subjects ({state.players.length})
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
