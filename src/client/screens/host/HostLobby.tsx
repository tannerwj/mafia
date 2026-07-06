// HostLobby (D1, Spec 11 Feature 4 / Spec 06 D1 slice): player list +
// presence + kick + room code/share + a LIVE role-count editor. The host sets
// per-role counts with steppers (mafia / detective / angel / suicide bomber /
// minion; villagers = remainder); `validateRuleset` runs live so Start is
// enabled only for a legal setup, which unlocks small games (1 mafia + 2
// villagers = 3 players). Every edit broadcasts `set_ruleset` (debounced) so
// players see the roster (counts only) via `pendingRuleset`. The chosen
// ruleset is handed up to `onStartGame`.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientRoomState } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Stamp } from "../../components/ui/dossier";
import HelpButton from "../../components/HelpButton";
import { HOUSE_RULES, autoMafiaCount, validateRuleset, type Ruleset } from "../../../engine";
import { setRuleset as sendSetRuleset } from "../../store/gameStore";
import { hostSeatRows } from "../../store/hostView";
import { PlayerTable } from "./PlayerTable";
import PrivacyChip from "./PrivacyChip";

// The roles the host can dial (villagers are the remainder). Order is the
// stable display order.
const EDITABLE_ROLES: { id: string; label: string }[] = [
  { id: "mafia", label: "Mafia" },
  { id: "detective", label: "Detective" },
  { id: "angel", label: "Angel" },
  { id: "suicide_bomber", label: "Suicide bomber" },
  { id: "minion", label: "Minion" },
];

const SET_RULESET_DEBOUNCE_MS = 250;

type Counts = Record<string, number>;

function countsFromRuleset(roles: Record<string, number | "auto">): Counts {
  const out: Counts = {};
  for (const { id } of EDITABLE_ROLES) {
    const v = roles[id];
    out[id] = typeof v === "number" ? v : id === "mafia" ? 1 : 0;
  }
  return out;
}

// The wire ruleset: explicit editable counts + villager as the auto remainder,
// every other field inherited from the house ruleset (only counts are
// editable this round — Spec 11 non-goal).
function rulesetFromCounts(counts: Counts): Ruleset {
  return {
    ...HOUSE_RULES,
    roles: {
      villager: "auto",
      mafia: counts.mafia ?? 1,
      detective: counts.detective ?? 0,
      angel: counts.angel ?? 0,
      suicide_bomber: counts.suicide_bomber ?? 0,
      minion: counts.minion ?? 0,
    },
  };
}

function Stepper({
  label,
  value,
  min,
  onChange,
  testid,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (next: number) => void;
  testid: string;
}) {
  return (
    <div
      data-testid={testid}
      data-count={value}
      className="flex items-center justify-between gap-2 rounded-sm border border-frame bg-ink-2 px-3 py-2"
    >
      <span className="text-sm text-paper">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`${testid}-dec`}
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
          className="flex h-11 w-11 items-center justify-center rounded-sm border border-frame text-lg text-paper disabled:opacity-40"
        >
          −
        </button>
        <span data-testid={`${testid}-value`} className="w-6 text-center tabular-nums text-brass-hi">
          {value}
        </span>
        <button
          type="button"
          data-testid={`${testid}-inc`}
          aria-label={`Increase ${label}`}
          onClick={() => onChange(value + 1)}
          className="flex h-11 w-11 items-center justify-center rounded-sm border border-frame text-lg text-paper"
        >
          +
        </button>
      </div>
    </div>
  );
}

function RoleCountEditor({
  counts,
  villagers,
  playerCount,
  onChange,
}: {
  counts: Counts;
  villagers: number;
  playerCount: number;
  onChange: (id: string, next: number) => void;
}) {
  const mafiaHint = autoMafiaCount(Math.max(playerCount, 1), "sqrt");
  return (
    <Card data-testid="role-count-editor" className="w-full bg-ink-3">
      <CardHeader className="pb-2">
        <CardTitle>Cast the case</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pb-4">
        {EDITABLE_ROLES.map((r) => (
          <Stepper
            key={r.id}
            label={r.label}
            value={counts[r.id] ?? 0}
            min={r.id === "mafia" ? 1 : 0}
            onChange={(next) => onChange(r.id, next)}
            testid={`role-count-${r.id}`}
          />
        ))}
        <div
          data-testid="role-count-villager"
          data-count={villagers}
          className="flex items-center justify-between gap-2 rounded-sm border border-dashed border-frame bg-ink-2 px-3 py-2"
        >
          <span className="text-sm text-paper">Villagers</span>
          <span className="w-6 text-center tabular-nums text-smoke">{villagers}</span>
        </div>
        <p className="mt-1 text-[0.7rem] text-smoke">
          // Villagers fill the remainder. Suggested mafia for {playerCount || "—"} players:{" "}
          {mafiaHint}. Consider a day timer for unattended play.
        </p>
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
  onStartGame: (ruleset: Ruleset) => void;
}) {
  const rows = hostSeatRows(state);
  const playerCount = state.players.length;

  // Seed the editor from the broadcast pending ruleset (so a reconnecting host
  // sees their own prior edits) falling back to the house ruleset.
  const [counts, setCounts] = useState<Counts>(() =>
    countsFromRuleset(state.pendingRuleset?.roles ?? HOUSE_RULES.roles),
  );

  const editableTotal = EDITABLE_ROLES.reduce((sum, r) => sum + (counts[r.id] ?? 0), 0);
  const villagers = Math.max(0, playerCount - editableTotal);
  const ruleset = useMemo(() => rulesetFromCounts(counts), [counts]);
  const validation = validateRuleset(ruleset, playerCount);
  const canStart = playerCount >= 3 && validation.errors.length === 0;
  const startBlockedReason =
    playerCount < 3 ? "Need at least 3 players" : validation.errors[0]?.message ?? "Adjust the roster";

  // Debounced set_ruleset broadcast (Spec 06: debounced, excluded from
  // lastActivityAt server-side). Skip the very first render so we don't echo
  // the seed back immediately.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const t = setTimeout(() => sendSetRuleset(ruleset), SET_RULESET_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [ruleset]);

  function handleCount(id: string, next: number) {
    setCounts((prev) => ({ ...prev, [id]: Math.max(id === "mafia" ? 1 : 0, next) }));
  }

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
            Subjects ({playerCount})
          </p>
          <PlayerTable rows={rows} inGame={false} lobbyMode onKick={onKick} />
        </div>

        <div className="flex flex-col gap-4">
          <RoleCountEditor
            counts={counts}
            villagers={villagers}
            playerCount={playerCount}
            onChange={handleCount}
          />
          <Button
            type="button"
            data-testid="start-game"
            onClick={() => onStartGame(ruleset)}
            disabled={!canStart}
            size="lg"
            variant="brass"
            className="w-full"
          >
            {canStart ? "Start game" : startBlockedReason}
          </Button>
        </div>
      </div>
    </main>
  );
}
