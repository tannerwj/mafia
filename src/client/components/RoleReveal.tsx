// D2: role is shown once at assignment via a Radix Dialog that auto-dismisses
// after 5s, then stays hidden behind HoldToPeek for the rest of the game.
// The dialog re-arms whenever `roleId` changes value from what was last
// auto-shown (covers: fresh join after game start, and — defensively — a
// role reassignment, though the engine never reassigns roles mid-game).
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import HoldToPeek from "./HoldToPeek";
import { roleCopyFor } from "../lib/roleCopy";

const AUTO_DISMISS_MS = 5000;

/** `mafiaRoster`/`isMinion` are the extra knowledge grants Spec 08 D4 pins
 * for the "My Role" reveal ("mafia roster/minion info as already granted
 * by the projection") — both optional so the plain auto-reveal/HoldToPeek
 * call sites (which never passed them) keep working unchanged. */
export function RoleCard({
  roleId,
  mafiaRoster,
  playerNames,
}: {
  roleId: string;
  mafiaRoster?: string[] | undefined;
  playerNames?: Map<string, string> | undefined;
}) {
  const copy = roleCopyFor(roleId);
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {/* Paperclip riding the top edge of the classified assignment. */}
      <span aria-hidden className="-mt-2 text-2xl leading-none text-smoke">
        🖇
      </span>
      <p className="text-[0.65rem] uppercase tracking-[0.35em] text-smoke">
        Classified assignment
      </p>
      <h2 className="file-heading text-4xl leading-none text-brass-hi">
        {copy.displayName}
      </h2>
      {copy.blurb && (
        <p className="max-w-xs text-sm text-paper/80">
          <span aria-hidden className="mr-1 select-none text-smoke">
            //
          </span>
          {copy.blurb}
        </p>
      )}
      {mafiaRoster && (
        <div data-testid="role-card-mafia-roster" className="mt-2 w-full text-left text-sm">
          <p className="mb-1 text-[0.65rem] uppercase tracking-[0.15em] text-smoke">
            {roleId === "minion" ? "The Syndicate" : "Your associates"}
          </p>
          {mafiaRoster.length === 0 ? (
            <p className="text-paper/80">No known associates.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {mafiaRoster.map((id) => (
                <li key={id} className="text-blood">
                  {playerNames?.get(id) ?? id}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function RoleReveal({ roleId }: { roleId: string }) {
  const [open, setOpen] = useState(false);
  const shownForRef = useRef<string | null>(null);

  // Guards against re-arming the auto-dismiss timer on every re-render (the
  // dialog should only (re)open when `roleId` actually changes value), while
  // still arming a fresh timer on every real effect run — including React
  // StrictMode's dev-only mount→cleanup→mount double-invoke, which would
  // otherwise clear the one-and-only timer on the throwaway first pass and
  // leave the ref-guard blocking a replacement on the real second pass,
  // stranding the dialog open forever. The guard only decides whether to
  // OPEN the dialog; the timer itself is armed unconditionally by every
  // effect invocation and always cleaned up by that same invocation.
  useEffect(() => {
    if (shownForRef.current !== roleId) {
      shownForRef.current = roleId;
      setOpen(true);
    }
    const timer = setTimeout(() => setOpen(false), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [roleId]);

  return (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/90" />
          <Dialog.Content
            data-testid="role-reveal-dialog"
            className="file-frame animate-rise fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-md bg-ink-2 p-8 shadow-card"
          >
            <Dialog.Title asChild>
              <span className="sr-only">Your role has been assigned</span>
            </Dialog.Title>
            <Dialog.Description asChild>
              <span className="sr-only">
                This dialog closes automatically after five seconds.
              </span>
            </Dialog.Description>
            <RoleCard roleId={roleId} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <HoldToPeek>
        <RoleCard roleId={roleId} />
      </HoldToPeek>
    </>
  );
}
