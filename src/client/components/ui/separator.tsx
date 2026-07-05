// shadcn `separator` (new-york), copied in and themed to noir (Spec 09 D1).
// A plain hairline divider — no Radix primitive needed (that's a separate
// package outside the closed dependency budget); a decorative `<div>` with
// the right ARIA role covers every use here. `smoke/40` to match the one
// border vocabulary.
import * as React from "react";
import { cn } from "../../lib/cn";

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
}

export const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  ({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
    <div
      ref={ref}
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        "shrink-0 bg-frame",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = "Separator";
