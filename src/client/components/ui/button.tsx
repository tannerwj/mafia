// shadcn `button` (new-york), copied in by hand and re-skinned to the Case
// File dossier look (Spec 10 D1). Variant/size KEYS are unchanged
// (default/destructive/outline/ghost/brass; default/sm/lg/icon) so every call
// site and E2E button-text assertion is untouched — only the resolved
// appearance changes: crisp near-square corners, a monospace uppercase
// "typed control" voice, dashed/olive framing. `brass` is now the olive
// evidence-tab accent (the primary action); `default`/`destructive` are the
// stamp-red danger controls.
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-bold uppercase tracking-[0.1em] " +
    "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-hi " +
    "focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-blood text-bone hover:bg-blood/90",
        destructive: "bg-blood text-bone hover:bg-blood/90",
        outline: "file-frame bg-transparent text-paper hover:bg-ink-3",
        ghost: "bg-transparent text-paper hover:bg-ink-3",
        brass: "border border-brass bg-brass/15 text-brass-hi hover:bg-brass/25",
      },
      // Every size keeps a >=44px tap target (D2 pin) — even "sm" only shrinks
      // horizontal padding, never the 44px minimum height.
      size: {
        default: "h-11 px-5 py-2",
        sm: "h-11 px-3 text-sm",
        lg: "h-12 px-8 text-base",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export { buttonVariants };

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
