// Spec 15 — the AI narrator ("The Storyteller"). Two pieces:
//  - `StorytellerSetupButton`: opens a dialog with the enabled toggle, theme
//    free-text, and 5-tone picker. Reachable from the host lobby AND in-game
//    (same component, different mount point) — settings are a host
//    preference, not phase-gated.
//  - `StorytellerPanel`: the in-game "Spin the tale" button + draft panel,
//    shown only when the current phase is a legal beat (the host console
//    passes in which beat applies; see HostGame.tsx). No Keep button —
//    auto-keep commits on beat supersession server-side (§Product shape);
//    this panel only offers [Re-spin] and [Discard].
//
// Kept-scene history renders from `ClientRoomState.story.scenes` — the ONLY
// story surface that rides the snapshot; the pending draft is local-only
// (`useGameStore.storyDraft`), matching the spec's ephemeral-draft design.
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { BeatId, StoryState, Tone } from "../../../shared/protocol";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { discardStory, generateStory, setStorySettings, useGameStore } from "../../store/gameStore";

const TONES: { id: Tone; label: string }[] = [
  { id: "noir", label: "Noir" },
  { id: "cozy", label: "Cozy" },
  { id: "horror", label: "Horror" },
  { id: "comedy", label: "Comedy" },
  { id: "absurd", label: "Absurd" },
];

const BEAT_LABEL: Record<BeatId, string> = {
  "sunrise-hold": "Set the morning atmosphere",
  "sunset-hold": "Set the evening atmosphere",
  "morning-report": "Spin the morning report",
  "post-vote": "Spin the verdict",
  epilogue: "Spin the epilogue",
};

/** The setup dialog's contents — shared by the lobby card and the in-game
 * reachable entry point. `story` seeds the initial fields; `null` (a viewer
 * who hasn't seen a storyState yet, e.g. brand-new room) falls back to
 * disabled/blank, matching the server's own eager-init default. */
function StorytellerSetupDialog({ story, open, onOpenChange }: { story: StoryState | null | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [enabled, setEnabled] = useState(story?.enabled ?? false);
  const [theme, setTheme] = useState(story?.settings.theme ?? "");
  const [tone, setTone] = useState<Tone>(story?.settings.tone ?? "noir");

  function commit(next: { enabled?: boolean; theme?: string; tone?: Tone }) {
    const merged = { enabled, theme, tone, ...next };
    setEnabled(merged.enabled);
    setTheme(merged.theme);
    setTone(merged.tone);
    setStorySettings(merged.enabled, merged.theme, merged.tone);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/90" />
        <Dialog.Content
          data-testid="storyteller-setup-dialog"
          className="file-frame animate-rise fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md bg-ink-2 p-6 shadow-card"
        >
          <Dialog.Title asChild>
            <h2 className="file-heading text-lg text-brass-hi">The Storyteller</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p className="mt-1 text-sm text-paper/80">
              An AI writers'-room for the narrator — one tap generates a short scene between beats.
            </p>
          </Dialog.Description>

          <div className="mt-4 flex flex-col gap-4">
            <button
              type="button"
              data-testid="storyteller-enabled-toggle"
              role="switch"
              aria-checked={enabled}
              onClick={() => commit({ enabled: !enabled })}
              className="flex min-h-11 items-center justify-between gap-3 rounded-sm border border-frame bg-ink-3 px-3 py-2 text-left"
            >
              <span className="text-sm text-paper">Enable the Storyteller</span>
              <span
                aria-hidden
                className={`flex h-6 w-11 shrink-0 items-center rounded-full border px-0.5 transition-colors ${
                  enabled ? "justify-end border-brass bg-ink" : "justify-start border-frame bg-ink-2"
                }`}
              >
                <span className={`h-4 w-4 rounded-full ${enabled ? "bg-brass-hi" : "bg-smoke"}`} />
              </span>
            </button>

            <label className="flex flex-col gap-1">
              <span className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">Theme (optional)</span>
              <input
                data-testid="storyteller-theme-input"
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                onBlur={() => commit({})}
                placeholder="e.g. a snowed-in ski lodge"
                className="rounded-sm border border-frame bg-ink px-3 py-2 text-sm text-paper"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[0.65rem] uppercase tracking-[0.2em] text-smoke">Tone</span>
              <div className="flex flex-wrap gap-2" data-testid="storyteller-tone-picker">
                {TONES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    data-testid={`storyteller-tone-${t.id}`}
                    onClick={() => commit({ tone: t.id })}
                    className={`min-h-9 rounded-sm border px-3 py-1.5 text-xs uppercase tracking-[0.1em] ${
                      tone === t.id ? "border-brass bg-brass/20 text-brass-hi" : "border-frame text-smoke hover:text-paper"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <Dialog.Close asChild>
              <Button type="button" variant="brass" data-testid="storyteller-setup-close">
                Done
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Button + dialog, mountable anywhere in the host console (lobby card or
 * in-game). `story` should be `room.story` — `undefined`/`null` for a
 * pre-first-broadcast host viewer is handled by the dialog's own fallback. */
export function StorytellerSetupButton({ story }: { story: StoryState | null | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" data-testid="storyteller-setup-open" variant="outline" onClick={() => setOpen(true)}>
        {story?.enabled ? "Storyteller: on" : "Storyteller"}
      </Button>
      <StorytellerSetupDialog story={story} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** The in-game "Spin the tale" control + draft panel + kept-scene history.
 * `legalBeat` is `null` when the current phase offers no beat (most phases —
 * only sunrise/sunset/dawn/dusk/ended do); the panel renders history-only
 * (or nothing at all if the Storyteller has never been enabled) in that case. */
export function StorytellerPanel({ story, legalBeat, phaseGen }: { story: StoryState | null | undefined; legalBeat: BeatId | null; phaseGen: number }) {
  const draft = useGameStore((s) => s.storyDraft);

  if (!story?.enabled && story?.scenes.length === 0) return null;
  if (!story) return null;

  return (
    <Card data-testid="storyteller-panel" className="w-full bg-ink-3">
      <CardHeader className="pb-2">
        <CardTitle>The Storyteller</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pb-4">
        {legalBeat && story.enabled && (
          <Button
            type="button"
            data-testid="spin-the-tale"
            variant="brass"
            disabled={draft?.status === "pending"}
            onClick={() => generateStory(legalBeat, phaseGen)}
            className="w-full"
          >
            {draft?.status === "pending" ? "Spinning…" : BEAT_LABEL[legalBeat]}
          </Button>
        )}

        {draft && (
          <div data-testid="storyteller-draft" className="flex flex-col gap-2 rounded-sm border border-brass/40 bg-ink-2 p-3">
            {draft.status === "pending" && <p className="text-sm text-smoke">// The muse is thinking…</p>}
            {draft.status === "ready" && (
              <>
                <p data-testid="storyteller-draft-text" className="text-sm text-paper">
                  {draft.text}
                </p>
                <div className="flex gap-2">
                  <Button type="button" data-testid="storyteller-respin" variant="outline" size="sm" onClick={() => legalBeat && generateStory(legalBeat, phaseGen)}>
                    Re-spin
                  </Button>
                  <Button type="button" data-testid="storyteller-discard" variant="outline" size="sm" onClick={() => discardStory()}>
                    Discard
                  </Button>
                </div>
              </>
            )}
            {draft.status === "error" && (
              <>
                <p data-testid="storyteller-draft-error" className="text-sm text-blood">
                  {draft.error}
                </p>
                {legalBeat && (
                  <Button type="button" data-testid="storyteller-respin" variant="outline" size="sm" onClick={() => generateStory(legalBeat, phaseGen)}>
                    Try again
                  </Button>
                )}
              </>
            )}
          </div>
        )}

        {story.scenes.length > 0 && (
          <div data-testid="storyteller-history" className="flex flex-col gap-2">
            <p className="text-[0.6rem] uppercase tracking-[0.2em] text-smoke">Kept scenes</p>
            <ul className="flex flex-col gap-2">
              {story.scenes.map((s, i) => (
                <li key={i} data-testid="storyteller-history-row" className="rounded-sm border border-frame bg-ink-2 p-2 text-xs text-paper/80">
                  <span className="mr-2 text-smoke">Day {s.day} —</span>
                  {s.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Maps the current game phase to its legal beat, or `null` for phases with
 * none (night/day/runoff). Mirrors the server's BEAT_PHASE table exactly —
 * this is presentation-only routing, the server is the actual authority
 * (a stale/mismatched phaseGen or phase is rejected there regardless). */
export function legalBeatForPhase(phase: string): BeatId | null {
  switch (phase) {
    case "sunrise":
      return "sunrise-hold";
    case "sunset":
      return "sunset-hold";
    case "dawn":
      return "morning-report";
    case "dusk":
      return "post-vote";
    case "ended":
      return "epilogue";
    default:
      return null;
  }
}
