import { useEffect, useState } from "react";
import type { ConnectionStatus } from "../net/RoomConnection";

// Persistent thin banner slot (D1 pin): hidden when healthy, "Reconnecting…"
// (smoke) on drop, "Back" (brass, 2s) on recovery. Keeps the same
// `data-testid="connection-banner"` contract Spec 01's lobby.spec.ts already
// asserts on (`toBeVisible()` while reconnecting, `toHaveCount(0)` once
// healthy) — the "Back" flash below re-renders the DOM node briefly on
// recovery but does not change when it disappears for good, so that suite
// stays green unmodified.
export default function ConnectionBanner({
  status,
}: {
  status: ConnectionStatus;
}) {
  const [showBack, setShowBack] = useState(false);
  const [wasDown, setWasDown] = useState(false);
  const [everOpened, setEverOpened] = useState(status === "open");

  // Only a genuine drop-then-recover counts as "Back" — the very first
  // connection on page load also passes through "connecting" on its way to
  // "open" the first time, which is not a recovery and must never flash the
  // brass banner. The status string alone can't distinguish the two cases:
  // `RoomConnection.forceRecycle()` (liveness-timeout-triggered recycle, the
  // path a hard socket kill / offline toggle can take) resets its internal
  // attempt counter and re-labels the retry as "connecting" too, not just
  // "reconnecting" — so gating on "reconnecting" alone missed that recovery
  // path (a real drop-then-recover this way never flashed "Back" at all).
  // The correct signal is "have we ever reached open before" — any drop
  // away from a session that has already opened once, regardless of which
  // status label the retry uses, is a recovery in progress.
  //
  // This is split into two effects on purpose. A single effect that both
  // (a) transitions `wasDown` -> `showBack` and (b) resets `wasDown` to
  // false in that same run was found to self-cancel: `wasDown` is in that
  // effect's own dependency array, so setting it to false immediately
  // re-runs the effect (React tears down the just-armed 2s timeout via its
  // cleanup before the timeout ever fires), permanently stranding
  // `showBack` at `true` — the exact bug behind the "Back" banner never
  // clearing (found via direct render-log tracing, Spec 04 fix-round-4).
  // Splitting the "detect open-after-down" transition from "own the 2s
  // timer" into separate effects means the timer-owning effect only
  // depends on `showBack` itself, which it does not also set to a value
  // that re-triggers itself mid-run.
  useEffect(() => {
    if (status === "open") {
      setEverOpened(true);
      if (wasDown) {
        setWasDown(false);
        setShowBack(true);
      }
      return;
    }
    if (everOpened && (status === "reconnecting" || status === "connecting")) {
      setWasDown(true);
    }
  }, [status, wasDown, everOpened]);

  useEffect(() => {
    if (!showBack) return;
    const t = setTimeout(() => setShowBack(false), 2000);
    return () => clearTimeout(t);
  }, [showBack]);

  if (status === "closed") return null;
  if (status === "open" && !showBack) return null;

  const isBack = status === "open" && showBack;
  const label = isBack
    ? "Line restored"
    : status === "connecting"
      ? "Reaching the wire…"
      : "Line dropped — redialing…";

  return (
    <div
      data-testid="connection-banner"
      data-status={status}
      role="status"
      aria-live="polite"
      className={`safe-pt w-full px-4 py-2 text-center text-xs font-bold uppercase tracking-[0.15em] transition-colors ${
        isBack ? "bg-brass text-ink" : "bg-ink-3 text-paper"
      }`}
    >
      {label}
    </div>
  );
}
