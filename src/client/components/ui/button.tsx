// Hand-written equivalent of `npx shadcn@latest add button` (new-york style).
// No CLI/network access in this environment (see 04-implementation-notes.md),
// so this follows shadcn's standard Button source pattern by hand: a
// `buttonVariants` class-map + a `Button` that forwards a native `<button>`
// (or, via `asChild`, clones its single child) — adapted to noir tokens
// instead of the default shadcn palette, and to this repo's dependency
// budget (`cn()` here has no `class-variance-authority`/`clsx`/
// `tailwind-merge` — see lib/cn.ts).
import * as React from "react";
import { cn } from "../../lib/cn";

export type ButtonVariant =
  | "default"
  | "destructive"
  | "outline"
  | "ghost"
  | "brass";
export type ButtonSize = "default" | "sm" | "lg" | "icon";

const baseClasses =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium " +
  "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:pointer-events-none disabled:opacity-50";

const variantClasses: Record<ButtonVariant, string> = {
  default: "bg-blood text-bone hover:bg-blood/90",
  destructive: "bg-blood text-bone hover:bg-blood/90",
  outline: "border border-smoke bg-transparent text-bone hover:bg-ink-3",
  ghost: "bg-transparent text-bone hover:bg-ink-3",
  brass: "bg-brass text-ink font-semibold hover:bg-brass/90",
};

// Every size keeps a >=44px tap target (D2 pin) — even "sm" only shrinks
// horizontal padding, never the 44px minimum height.
const sizeClasses: Record<ButtonSize, string> = {
  default: "h-11 px-5 py-2",
  sm: "h-11 px-3 text-sm",
  lg: "h-12 px-8 text-base",
  icon: "h-11 w-11",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", type, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          baseClasses,
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
