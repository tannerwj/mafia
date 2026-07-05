// Shared confirm dialog (D2) for the host console's dangerous controls
// (force_advance, new_game). Reuses Spec 04's Radix Dialog primitive/pattern
// (`RoleReveal.tsx`) rather than adding a new one. `onConfirm` fires exactly
// once per open dialog — the caller is responsible for capturing anything
// that must be read at OPEN time (e.g. `phaseGen`) before rendering this,
// since the dialog itself holds no game state.
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "./ui/button";

export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  testId: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/90" />
        <Dialog.Content
          data-testid={testId}
          className="file-frame animate-rise fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md bg-ink-2 p-6 shadow-card"
        >
          <Dialog.Title asChild>
            <h2 className="file-heading text-lg text-brass-hi">{title}</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p className="mt-2 text-sm text-paper/80">{description}</p>
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close asChild>
              <Button type="button" variant="outline" data-testid={`${testId}-cancel`}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              type="button"
              variant="destructive"
              data-testid={`${testId}-confirm`}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
