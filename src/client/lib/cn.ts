// Minimal `cn()` — joins truthy class-name fragments with a single space.
//
// The shadcn `Button` pattern normally pairs `clsx` + `tailwind-merge` for
// this, but neither is in this spec's closed dependency budget (D1: exactly
// zustand, @radix-ui/react-dialog, vaul, sonner,
// @fontsource-variable/playfair-display — nothing else without a documented
// justification). This app's class lists are short and hand-written (no
// conflicting Tailwind utility pairs generated dynamically), so a bare
// filter+join covers every call site here without needing tailwind-merge's
// conflict resolution. See docs/specs/04-implementation-notes.md.
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
