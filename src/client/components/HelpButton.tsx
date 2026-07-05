// "?" help affordance (Spec 08 D4) — opens the Instructions modal. A thin
// self-contained wrapper (owns its own open state) so every call site
// (player lobby, host lobby, in-game headers) can drop it in without each
// one re-managing a boolean.
import { useState } from "react";
import InstructionsModal from "./Instructions";

export default function HelpButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="help-button"
        aria-label="How to play"
        onClick={() => setOpen(true)}
        className={
          className ??
          "flex h-11 w-11 items-center justify-center rounded-full border border-smoke bg-ink-2 text-lg text-bone"
        }
      >
        ?
      </button>
      <InstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
