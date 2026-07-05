// Persistent one-tap "My Role" control (Spec 08 D4) — a small fixed button
// in every in-game phase that opens the same role-reveal card `RoleReveal`'s
// 5s auto-dismiss Dialog uses, including mafia roster/minion info already
// granted by the projection. Unlike HoldToPeek (privacy-first press-and-hold,
// unchanged by this spec), this is a deliberate one-tap open that stays open
// until the player dismisses it — nothing role-identifying is ever on screen
// until they tap it, so privacy is preserved the same way HoldToPeek's own
// content is: mount-then-dismiss, never a permanently-mounted role badge.
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button } from "./ui/button";
import { RoleCard } from "./RoleReveal";

export default function MyRoleButton({
  roleId,
  mafiaRoster,
  playerNames,
}: {
  roleId: string;
  mafiaRoster?: string[] | undefined;
  playerNames?: Map<string, string> | undefined;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        data-testid="my-role-button"
        aria-label="My role"
        onClick={() => setOpen(true)}
        className="fixed bottom-3 left-3 z-60 flex h-11 min-w-11 items-center gap-2 rounded-sm border-2 border-frame bg-ink-2 px-4 text-xs font-bold uppercase tracking-[0.1em] text-paper shadow-lg safe-bottom safe-x active:border-brass"
      >
        <span aria-hidden="true">🗂</span>
        My File
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/90" />
          <Dialog.Content
            data-testid="my-role-dialog"
            className="file-frame animate-rise fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-md bg-ink-2 p-8 shadow-card"
          >
            <Dialog.Title asChild>
              <span className="sr-only">Your role</span>
            </Dialog.Title>
            <Dialog.Description asChild>
              <span className="sr-only">Tap outside or close to dismiss.</span>
            </Dialog.Description>
            <RoleCard roleId={roleId} mafiaRoster={mafiaRoster} playerNames={playerNames} />
            <Dialog.Close asChild>
              <Button
                type="button"
                data-testid="my-role-dialog-close"
                variant="outline"
                className="mt-6 w-full"
              >
                Close
              </Button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
