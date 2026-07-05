// Persistent discreet privacy warning (D1 pin) — the console shows every
// role; players will glance at the host's phone at a party. Rendered in the
// header of every host screen.
export default function PrivacyChip() {
  return (
    <span
      data-testid="privacy-chip"
      className="inline-flex items-center gap-1.5 rounded-full border border-smoke/60 bg-ink-3 px-3 py-1 text-xs text-smoke"
    >
      <span aria-hidden>🎭</span>
      arbitrator screen — keep it private
    </span>
  );
}
