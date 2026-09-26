// HostLobby (D1, Spec 11 Feature 4 / Spec 06 D1 slice; Spec 13 scaled
// recommendations): player list + presence + kick + room code/share + a LIVE
// role-count editor. The host sets per-role counts with steppers (mafia /
// detective / angel / suicide bomber / minion; villagers = remainder);
// `validateRuleset` runs live so Start is enabled only for a legal setup,
// which unlocks small games (1 mafia + 2 villagers = 3 players). Every edit
// broadcasts `set_ruleset` (debounced) so players see the roster (counts
// only) via `pendingRuleset`. The chosen ruleset is handed up to
// `onStartGame`.
//
// Spec 13: until the host touches a stepper, counts track
// `recommendedRoleCounts(playerCount)` live (recomputed as players join/leave)
// WITHOUT broadcasting — the engine's all-auto `HOUSE_RULES` already resolves
// the same way server-side, so an untouched room needs no wire traffic. The
// first stepper edit freezes the displayed counts to explicit numbers and
// starts broadcasting (existing wire shape: explicit numbers + villager:
// "auto"). "Reset to suggested" flips back to all-auto and broadcasts once so
// players see the change too.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientRoomState } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Stamp } from "../../components/ui/dossier";
import HelpButton from "../../components/HelpButton";
import QrCode from "../../components/QrCode";
import { HOUSE_RULES, recommendedRoleCounts, validateRuleset, type Ruleset } from "../../../engine";
import {
  countsFromRecommendation,
  countsFromRuleset,
  EDITABLE_ROLES,
  isAllAuto,
  suggestionHint,
  type Counts,
} from "../../lib/hostRoleCounts";
import { setRuleset as sendSetRuleset } from "../../store/gameStore";
import { hostSeatRows } from "../../store/hostView";
import { PlayerTable } from "./PlayerTable";
import PrivacyChip from "./PrivacyChip";
import { StorytellerSetupButton } from "./Storyteller";

const SET_RULESET_DEBOUNCE_MS = 250;

// The wire ruleset: explicit editable counts + villager as the auto remainder,
// plus the Spec 12 scenePhases toggle; every other field inherited from the
// house ruleset.
function rulesetFromCounts(counts: Counts, scenePhases: boolean): Ruleset {
  return {
    ...HOUSE_RULES,
    scenePhases,
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

// The all-auto ruleset broadcast by "Reset to suggested" — every house-six
// role (including villager) reverts to "auto" so the engine/other clients
// resolve via `recommendedRoleCounts` too. `scenePhases` is preserved by the
// caller, never clobbered.
function allAutoRuleset(scenePhases: boolean): Ruleset {
  return { ...HOUSE_RULES, scenePhases };
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
  modified,
  onChange,
  onReset,
}: {
  counts: Counts;
  villagers: number;
  playerCount: number;
  modified: boolean;
  onChange: (id: string, next: number) => void;
  onReset: () => void;
}) {
  return (
    <Card data-testid="role-count-editor" className="w-full bg-ink-3">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle>Cast the case</CardTitle>
        {modified && (
          <button
            type="button"
            data-testid="reset-to-suggested"
            onClick={onReset}
            className="min-h-8 rounded-sm border border-frame px-2 py-1 text-[0.65rem] uppercase tracking-[0.1em] text-smoke hover:text-paper"
          >
            Reset to suggested
          </button>
        )}
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
        <p data-testid="role-count-hint" className="mt-1 text-[0.7rem] text-smoke">
          // {suggestionHint(recommendedRoleCounts, playerCount)}. Villagers fill the remainder. Consider a day timer for
          unattended play.
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

  // Spec 13: `modified` tracks whether the host has touched a stepper (or
  // reconnected into an already-edited room) this session. While false, the
  // displayed counts track `recommendedRoleCounts(playerCount)` live and
  // nothing is broadcast — the engine's all-auto `HOUSE_RULES` resolves the
  // same way server-side. Seeded true if the broadcast pending ruleset (a
  // reconnecting host's own prior edits) isn't all-auto.
  const [modified, setModified] = useState<boolean>(() => {
    const roles = state.pendingRuleset?.roles;
    return roles ? !isAllAuto(roles) : false;
  });
  // Seed the editor from the broadcast pending ruleset (so a reconnecting host
  // sees their own prior edits) falling back to the house ruleset. Only
  // meaningful once `modified` — otherwise counts are derived live below.
  const [counts, setCounts] = useState<Counts>(() =>
    countsFromRuleset(recommendedRoleCounts, state.pendingRuleset?.roles ?? HOUSE_RULES.roles, playerCount),
  );
  // Spec 12: the sunrise/sunset toggle. Seeded from the broadcast pending
  // ruleset so a reconnecting host keeps their choice; defaults off.
  const [scenePhases, setScenePhases] = useState<boolean>(
    () => (state.pendingRuleset?.scenePhases as boolean | undefined) ?? HOUSE_RULES.scenePhases,
  );

  const displayedCounts = modified ? counts : countsFromRecommendation(recommendedRoleCounts, playerCount);
  const editableTotal = EDITABLE_ROLES.reduce((sum, r) => sum + (displayedCounts[r.id] ?? 0), 0);
  const villagers = Math.max(0, playerCount - editableTotal);
  const ruleset = useMemo(
    () => (modified ? rulesetFromCounts(counts, scenePhases) : allAutoRuleset(scenePhases)),
    [modified, counts, scenePhases],
  );
  const validation = validateRuleset(ruleset, playerCount);
  const canStart = playerCount >= 3 && validation.errors.length === 0;
  const startBlockedReason =
    playerCount < 3 ? "Need at least 3 players" : validation.errors[0]?.message ?? "Adjust the roster";

  // Debounced set_ruleset broadcast (Spec 06: debounced, excluded from
  // lastActivityAt server-side). Skip the very first render so we don't echo
  // the seed back immediately. While untouched (`!modified`), skip broadcast
  // entirely — the room started all-auto and stays all-auto server-side, no
  // wire traffic needed for player-count-driven recompute.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!modified) return;
    const t = setTimeout(() => sendSetRuleset(ruleset), SET_RULESET_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [modified, ruleset]);

  function handleCount(id: string, next: number) {
    // First edit freezes the live recommendation into explicit numbers.
    setCounts((prev) => {
      const base = modified ? prev : countsFromRecommendation(recommendedRoleCounts, playerCount);
      return { ...base, [id]: Math.max(id === "mafia" ? 1 : 0, next) };
    });
    setModified(true);
  }

  function handleReset() {
    setModified(false);
    setCounts(countsFromRecommendation(recommendedRoleCounts, playerCount));
    sendSetRuleset(allAutoRuleset(scenePhases));
  }

  return (
    <main className="page-p relative z-10 mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-center gap-6 bg-ink text-paper">
      <div className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col">
            <p className="text-[0.6rem] uppercase tracking-[0.3em] text-smoke">
              Lead investigator
            </p>
            <h1 className="file-heading text-2xl text-blood-hi">The Case Room</h1>
          </div>
          <Stamp variant="confidential" className="hidden text-[0.6rem] sm:inline-flex" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HelpButton />
          <PrivacyChip />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span
          data-testid="room-code"
          className="rounded-sm border border-frame bg-ink-2 px-6 py-3 text-3xl tracking-[0.3em] text-brass-hi"
        >
          {state.roomCode}
        </span>
        <Button type="button" data-testid="copy-link" onClick={onCopyLink} variant="outline">
          Share link
        </Button>
        <StorytellerSetupButton story={state.story} />
      </div>

      <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
            Subjects ({playerCount})
          </p>
          <PlayerTable rows={rows} inGame={false} lobbyMode onKick={onKick} />

          <div className="flex flex-col items-center gap-2 self-start rounded-sm border border-frame bg-ink-2 p-3">
            <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">
              Scan to join
            </p>
            <QrCode
              value={`${location.origin}/room/${state.roomCode}`}
              size={224}
              className="rounded-sm"
            />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <RoleCountEditor
            counts={displayedCounts}
            villagers={villagers}
            playerCount={playerCount}
            modified={modified}
            onChange={handleCount}
            onReset={handleReset}
          />
          <button
            type="button"
            data-testid="scene-phases-toggle"
            role="switch"
            aria-checked={scenePhases}
            onClick={() => setScenePhases((v) => !v)}
            className="flex min-h-11 items-center justify-between gap-3 rounded-sm border border-frame bg-ink-3 px-3 py-2 text-left"
          >
            <span className="flex flex-col">
              <span className="text-sm text-paper">Sunrise / sunset scenes</span>
              <span className="text-[0.7rem] text-smoke">
                // Narrator taps Reveal to set each scene aloud. In-person pacing.
              </span>
            </span>
            <span
              aria-hidden
              className={`flex h-6 w-11 shrink-0 items-center rounded-full border px-0.5 transition-colors ${
                scenePhases ? "justify-end border-brass bg-ink" : "justify-start border-frame bg-ink-2"
              }`}
            >
              <span className={`h-4 w-4 rounded-full ${scenePhases ? "bg-brass-hi" : "bg-smoke"}`} />
            </span>
          </button>
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
