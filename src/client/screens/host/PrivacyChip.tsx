// Persistent discreet privacy warning (D1 pin) — the console shows every
// role; players will glance at the host's phone at a party. Rendered in the
// header of every host screen.
export default function PrivacyChip() {
  return (
    <span
      data-testid="privacy-chip"
      className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-frame bg-ink-3 px-3 py-1 text-[0.65rem] uppercase tracking-[0.08em] text-smoke"
    >
      <span aria-hidden>🔒</span>
      {/* Below 400px the full warning doesn't fit next to the help button
          without overflowing the viewport (Spec 18 finding 1) — shorten to
          "eyes only" and let the rest of the sentence drop. */}
      <span className="hidden min-[400px]:inline">eyes only — keep this file private</span>
      <span className="min-[400px]:hidden">eyes only</span>
    </span>
  );
}
