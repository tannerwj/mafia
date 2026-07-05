// `cn()` — the standard shadcn class-name combiner: `clsx` for conditional
// joining + `tailwind-merge` for last-wins conflict resolution (so a caller's
// `className` override of a variant's utility actually wins instead of both
// classes landing in the list). Spec 09 D1 opens the closed dependency budget
// to exactly this trio (clsx + tailwind-merge, plus class-variance-authority
// for the Button/Badge variant maps) — the pre-09 hand-rolled filter+join
// couldn't resolve conflicting Tailwind utilities, which the shared shadcn
// primitives now generate.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export type { ClassValue };

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
