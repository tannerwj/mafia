// Press-and-hold-to-peek affordance (D2, design.md's "Reveal My Role" as a
// press-and-hold icon). Reveals `children` only while actively pressed;
// releasing (or the pointer leaving) hides it instantly — no toggle that
// can be left open on a table.
//
// Pinned implementation details from the spec:
// - Pointer events (not touch events) with pointer capture, so a drag off
//   the button doesn't lose the "pressed" state or leak a stray pointerup
//   to whatever's underneath.
// - `touch-action: none` / `-webkit-touch-callout: none` / `user-select:
//   none` (the `.no-callout` utility in index.css) so iOS's long-press
//   magnifier/selection menu doesn't fire instead of the reveal.
// - A11y fallback (REQUIRED, not optional): this is a real `<button>`, and
//   keyboard/AT activation (Enter/Space) gives a timed 3s reveal with an
//   `aria-live` announcement — hold-to-peek is an enhancement on top of a
//   keyboard-operable control, not the only path to the information.
import { useCallback, useEffect, useRef, useState } from "react";

const KEYBOARD_REVEAL_MS = 3000;

export default function HoldToPeek({
  children,
  label = "Hold to see your role",
}: {
  children: React.ReactNode;
  label?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerActiveRef = useRef(false);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const clearKeyboardTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startPointerReveal = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      pointerActiveRef.current = true;
      clearKeyboardTimer();
      setRevealed(true);
    },
    [clearKeyboardTimer],
  );

  const endPointerReveal = useCallback(() => {
    if (!pointerActiveRef.current) return;
    pointerActiveRef.current = false;
    setRevealed(false);
  }, []);

  // Keyboard/AT activation: Enter/Space (native button "click") gives a
  // timed 3s reveal instead of a press-hold gesture, announced via
  // aria-live so screen reader users know it's showing and for how long.
  const handleClick = useCallback(() => {
    if (pointerActiveRef.current) return; // pointer path already handled it
    clearKeyboardTimer();
    setRevealed(true);
    setAnnouncement("Role revealed for 3 seconds.");
    timerRef.current = setTimeout(() => {
      setRevealed(false);
      setAnnouncement("Role hidden.");
    }, KEYBOARD_REVEAL_MS);
  }, [clearKeyboardTimer]);

  // Fixed positioning + a z-index above the night-action drawer (z-40/z-50)
  // and the role-reveal dialog (z-40/z-50): the spec pins this affordance as
  // available "for the rest of the game", including while a mafia/detective/
  // angel's own night drawer (dismissible={false}) is open and would
  // otherwise cover an in-flow button underneath it. Persistent chrome, same
  // class as the connection banner — not scoped to any one phase screen.
  return (
    <div className="chip-inset-tr fixed z-60 flex flex-col items-center gap-2">
      <button
        type="button"
        data-testid="hold-to-peek"
        aria-pressed={revealed}
        className="no-callout flex h-14 w-14 select-none items-center justify-center rounded-sm border-2 border-frame bg-ink-2 text-2xl shadow-lg active:border-brass"
        onPointerDown={startPointerReveal}
        onPointerUp={endPointerReveal}
        onPointerCancel={endPointerReveal}
        onPointerLeave={endPointerReveal}
        onClick={handleClick}
      >
        <span aria-hidden="true">🔍</span>
        <span className="sr-only">{label}</span>
      </button>
      <div
        data-testid="hold-to-peek-live"
        aria-live="polite"
        className="sr-only"
      >
        {announcement}
      </div>
      <div
        data-testid="hold-to-peek-content"
        data-revealed={revealed}
        className={
          revealed
            ? "file-frame w-48 rounded-md bg-ink-2 p-4 shadow-xl"
            : "hidden"
        }
      >
        {children}
      </div>
    </div>
  );
}
