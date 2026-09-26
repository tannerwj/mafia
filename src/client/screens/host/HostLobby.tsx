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
import type { ClientRoomState, VisualTheme } from "../../../shared/protocol";
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
import { setRuleset as sendSetRuleset, setVisualTheme as sendSetVisualTheme } from "../../store/gameStore";
import { hostSeatRows } from "../../store/hostView";
import { PlayerTable } from "./PlayerTable";
import PrivacyChip from "./PrivacyChip";
import { StorytellerSetupButton } from "./Storyteller";

const SET_RULESET_DEBOUNCE_MS = 250;

const THEME_OPTIONS: Array<{
  id: VisualTheme;
  name: string;
  description: string;
}> = [
  { id: "atelier", name: "Noir Atelier", description: "Ink, paper, and a warm brass glow." },
  { id: "club", name: "Midnight Club", description: "Emerald velvet and champagne light." },
  { id: "rain", name: "Neon Rain", description: "Cobalt glass, amber, and city nights." },
];

function ThemePicker({ state }: { state: ClientRoomState }) {
  const selected = state.visualTheme;
  const [pending, setPending] = useState<VisualTheme | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const requestId = useRef(0);
  const selectedRef = useRef(selected);
  const timerRef = useRef<number | undefined>(undefined);
  const observedRef = useRef({ theme: selected, revision: state.visualThemeRevision });

  useEffect(() => {
    const snapshotChanged = observedRef.current.theme !== selected || observedRef.current.revision !== state.visualThemeRevision;
    selectedRef.current = selected;
    observedRef.current = { theme: selected, revision: state.visualThemeRevision };

    // A newer authoritative snapshot may come from another host tab. Once a
    // snapshot changes, the room's selected value is the source of truth even
    // if it differs from this tab's request; never let an old timeout paint a
    // stale error over that value.
    if (pending && snapshotChanged) {
      requestId.current += 1;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      setPending(null);
      setStatus("saved");
    }
  }, [pending, selected, state.visualThemeRevision]);

  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);

  function chooseTheme(theme: VisualTheme) {
    if (theme === selected) {
      setPending(null);
      setStatus("saved");
      return;
    }

    const currentRequest = ++requestId.current;
    setPending(theme);
    setStatus("saving");
    sendSetVisualTheme(theme);

    // A rejection is already surfaced by the store's shared toast. Clear the
    // local saving label after a bounded wait so a rejected command can never
    // leave the picker saying “saving” forever. The selected skin still comes
    // only from the authoritative snapshot above.
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (requestId.current === currentRequest && selectedRef.current !== theme) {
        setPending(null);
        setStatus("error");
      }
    }, 5000);
  }

  const selectedOption = THEME_OPTIONS.find((option) => option.id === selected) ?? THEME_OPTIONS[0]!;

  return (
    <section className="theme-picker" data-testid="theme-picker" aria-labelledby="table-look-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[0.65rem] uppercase tracking-[0.2em] text-brass-hi">Table look</p>
          <h2 id="table-look-title" className="mt-1 text-base font-semibold text-bone">Choose the room&apos;s mood</h2>
          <p className="mt-1 text-xs leading-relaxed text-paper/70">
            Everyone sees the same look. The change applies after the server saves it.
          </p>
        </div>
        <span className="rounded-full border border-frame px-2 py-1 text-[0.6rem] uppercase tracking-[0.1em] text-smoke">
          Host choice
        </span>
      </div>

      <div className="theme-options mt-4" role="group" aria-label="Choose table look">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            data-testid={`theme-option-${option.id}`}
            data-theme={option.id}
            aria-pressed={selected === option.id}
            aria-label={`${option.name}: ${option.description}`}
            onClick={() => chooseTheme(option.id)}
            className="theme-option"
          >
            <strong className="text-sm font-semibold leading-tight">{option.name}</strong>
            <small>{option.description}</small>
          </button>
        ))}
      </div>

      <p
        data-testid="theme-status"
        data-status={status}
        className="theme-status mt-3"
        role="status"
        aria-live="polite"
      >
        {status === "saving" && `Saving ${THEME_OPTIONS.find((option) => option.id === pending)?.name ?? "table look"}…`}
        {status === "saved" && `${selectedOption.name} is saved for the room.`}
        {status === "error" && "The table look could not be saved. Try again."}
        {status === "idle" && `${selectedOption.name} is selected.`}
      </p>
    </section>
  );
}

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
    <main data-testid="host-lobby" className="host-lobby-page page-p relative z-10 mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-5 text-paper">
      <header className="flex w-full flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div>
            <p className="text-[0.62rem] uppercase tracking-[0.28em] text-smoke">
              Host console · private room
            </p>
            <h1 className="file-heading mt-1 text-3xl text-bone">Set the table</h1>
            <p className="mt-1 max-w-xl text-sm text-paper/70">
              Share the room, choose the cast, then start when every seat is ready.
            </p>
          </div>
          <Stamp variant="confidential" className="hidden text-[0.6rem] sm:inline-flex" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HelpButton />
          <PrivacyChip />
        </div>
      </header>

      <ol className="host-setup-steps w-full" data-testid="host-setup-steps" aria-label="Setup steps">
        {[
          ["1", "Share room"],
          ["2", "Players join"],
          ["3", "Choose look + roles"],
          ["4", "Start game"],
        ].map(([number, label]) => (
          <li key={number} className="host-setup-step">
            <strong aria-hidden>{number}</strong>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      <section className="host-share-card" aria-labelledby="host-share-title">
        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <p className="text-[0.65rem] uppercase tracking-[0.2em] text-brass-hi">Share this room</p>
            <h2 id="host-share-title" className="mt-1 text-xl font-semibold text-bone">Invite players to the table</h2>
            <p className="mt-1 text-sm leading-relaxed text-paper/75">
              Use the code, link, or QR. Your host screen stays separate from player secrets.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="room-code" className="lobby-code">
              {state.roomCode}
            </span>
            <Button type="button" data-testid="copy-link" onClick={onCopyLink} variant="outline" className="host-share-action">
              Copy / share link
            </Button>
          </div>
          <p className="text-xs text-smoke" aria-live="polite">
            {playerCount === 0 ? "No players yet — keep this screen open while they join." : `${playerCount} ${playerCount === 1 ? "player" : "players"} joined.`}
          </p>
        </div>
        <div className="host-share-qr">
          <QrCode
            value={`${location.origin}/room/${state.roomCode}`}
            size={150}
            className="rounded-sm"
          />
          <span className="mt-1 text-[0.58rem] uppercase tracking-[0.12em] text-slate-900">Scan to join</span>
        </div>
      </section>

      <div className="grid w-full grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(19rem,0.9fr)]">
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="players-title">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">Step 2</p>
              <h2 id="players-title" className="mt-1 text-xl font-semibold text-bone">Players at the table</h2>
            </div>
            <span className="rounded-full border border-frame px-2.5 py-1 text-xs tabular-nums text-smoke">{playerCount} joined</span>
          </div>
          <PlayerTable rows={rows} inGame={false} lobbyMode onKick={onKick} />
          <p className="text-xs leading-relaxed text-smoke">
            Names and connection status are visible here. Roles and night actions stay private to each player.
          </p>
        </section>

        <section className="flex min-w-0 flex-col gap-4" aria-labelledby="setup-title">
          <div>
            <p className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">Step 3</p>
            <h2 id="setup-title" className="mt-1 text-xl font-semibold text-bone">Choose the setup</h2>
          </div>
          <ThemePicker state={state} />
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
                The host reveals each scene aloud for in-person pacing.
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
          <div className="flex items-center justify-between gap-3 rounded-md border border-frame bg-ink-2 px-3 py-3">
            <div>
              <p className="text-[0.63rem] uppercase tracking-[0.16em] text-smoke">Story setting</p>
              <p className="mt-1 text-xs text-paper/70">Optional narration style for the AI Storyteller.</p>
            </div>
            <StorytellerSetupButton story={state.story} />
          </div>
          <div className="flex flex-col gap-2">
            {!canStart && (
              <p data-testid="start-blocked-reason" className="text-sm text-blood-hi" role="status">
                {startBlockedReason}
              </p>
            )}
            <Button
              type="button"
              data-testid="start-game"
              onClick={() => onStartGame(ruleset)}
              disabled={!canStart}
              size="lg"
              variant="brass"
              className="w-full"
            >
              {canStart ? "Start game" : "Start game"}
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}
