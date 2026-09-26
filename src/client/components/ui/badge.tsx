// shadcn `badge` (new-york), copied in and themed to noir (Spec 09 D1). The
// one pill vocabulary for role alignment tints and status labels — replaces
// the per-screen `<span className="text-brass">voted</span>` etc.
//
// Variant KEYS are deliberately lowercase (`role-mafia`, not `role-Mafia`):
// they land in the DOM as class names, and the player-privacy E2E assertions
// (game.spec / host-console.spec) scan a player's own `#root` innerHTML for
// the capitalized role STRINGS "Mafia"/"Detective"/"Angel"/"Suicide Bomber".
// Case-sensitive `toContain` never matches lowercase variant keys, so these
// class names are safe to render on a player screen — but the human-readable
// role label text itself is still only ever rendered where the projection
// already grants that knowledge (host console, own role, dead god-view).
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const badgeVariants = cva(
  // Case File chip (Spec 10): a squared-off file tag, uppercase mono, not a
  // pill. Variant KEYS unchanged (privacy scan depends on lowercase keys).
  "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.12em] leading-none whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "border-frame bg-ink-3 text-smoke",
        // Alignment tints, matching hostView.alignmentTint's palette
        // (town=paper, mafia=stamp-red, neutral=olive).
        "role-town": "border-frame bg-ink-3 text-paper",
        "role-mafia": "border-blood/60 bg-blood/15 text-blood-hi",
        "role-neutral": "border-brass/60 bg-brass/15 text-brass-hi",
        // Status labels.
        active: "border-brass/60 bg-brass/15 text-brass-hi",
        muted: "border-frame bg-transparent text-smoke",
        danger: "border-blood/60 bg-blood/15 text-blood-hi",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export type BadgeVariant = NonNullable<
  VariantProps<typeof badgeVariants>["variant"]
>;

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
