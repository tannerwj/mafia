// Spec 10 D1 — the Case File motif primitives. These are the identity
// carriers reused across every screen: a rubber <Stamp>, a <Redaction> bar
// over hidden info, a dossier <FileCard> (framed sheet with an optional file
// tab), and a <FieldRow> (dot-leader label -> value). They compose the motif
// utilities defined in index.css (`.stamp`, `.redaction`, `.file-frame`,
// `.field-leader`) and the shared tokens, so there is one dossier vocabulary
// instead of per-screen ad-hoc markup.
import * as React from "react";
import { cn } from "../../lib/cn";

// --- Stamp -----------------------------------------------------------------

const STAMP_VARIANTS = {
  confidential: { tone: "stamp-red", label: "CONFIDENTIAL" },
  deceased: { tone: "stamp-red", label: "DECEASED" },
  cleared: { tone: "stamp-olive", label: "CLEARED" },
  suspect: { tone: "stamp-red", label: "SUSPECT" },
  "case-closed": { tone: "stamp-red", label: "CASE CLOSED" },
} as const;

export type StampVariant = keyof typeof STAMP_VARIANTS;

/** A rotated rubber-ink stamp. Pass `variant` for the canonical label/tone,
 * or override the text with children. `decorative` (default true when used as
 * a positioned overlay) sets `pointer-events:none` so a stamp can be layered
 * over a card without eating taps — the hard constraint. */
export function Stamp({
  variant,
  className,
  decorative,
  children,
  ...props
}: {
  variant: StampVariant;
  decorative?: boolean;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const { tone, label } = STAMP_VARIANTS[variant];
  return (
    <span
      aria-hidden={decorative || undefined}
      className={cn(
        "stamp text-xs",
        tone,
        decorative && "pointer-events-none",
        className,
      )}
      {...props}
    >
      {children ?? label}
    </span>
  );
}

// --- Redaction -------------------------------------------------------------

/** A solid marker-strike bar standing in for information the viewer isn't
 * allowed to see (unknown roles, hidden votes, an undecided teammate, the
 * tally before dusk). The hidden text is NOT rendered underneath — the bar
 * replaces it — so it is functionally honest, not just visual. `width` sizes
 * the bar (a redacted name ≈ 5rem); pass an aria-label for AT. */
export function Redaction({
  width = "5rem",
  className,
  label = "redacted",
  ...props
}: {
  width?: string;
  label?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("redaction align-middle", className)}
      style={{ width, height: "1.05em", ...props.style }}
      {...props}
    >
      {/* zero-width content keeps the box height stable across fonts */}
      &#8203;
    </span>
  );
}

// --- FileCard --------------------------------------------------------------

/** A dossier sheet: the raised paper surface with a dashed file frame and an
 * optional labeled file tab riding the top edge (e.g. "SUBJECT 04 — CAROL").
 * Replaces the Spec 09 rounded Card as the primary surface, though Card is
 * still re-skinned for plain panels. */
export const FileCard = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { tab?: React.ReactNode }
>(({ className, tab, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "file-frame relative rounded-md bg-ink-2 text-paper shadow-card",
      tab != null && "mt-3",
      className,
    )}
    {...props}
  >
    {tab != null && (
      <span className="absolute -top-3 left-3 inline-flex items-center rounded-t-sm border border-b-0 border-frame bg-ink-3 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-brass-hi">
        {tab}
      </span>
    )}
    {children}
  </div>
));
FileCard.displayName = "FileCard";

// --- FieldRow --------------------------------------------------------------

/** A typewritten field line: `LABEL ............ value`, the dots filling the
 * gap. The `value` may be a <Redaction> bar for hidden fields. */
export function FieldRow({
  label,
  value,
  className,
  valueClassName,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={cn("flex items-baseline text-sm", className)}>
      <span className="shrink-0 uppercase tracking-[0.12em] text-smoke">
        {label}
      </span>
      <span aria-hidden className="field-leader" />
      <span className={cn("shrink-0 text-right text-paper", valueClassName)}>
        {value}
      </span>
    </div>
  );
}

/** A `// comment`-style metadata line — faded, monospace, prefixed with the
 * typewritten double-slash the identity uses for helper/secondary copy. */
export function CommentLine({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-sm text-smoke", className)} {...props}>
      <span aria-hidden className="mr-1 select-none">
        //
      </span>
      {children}
    </p>
  );
}
