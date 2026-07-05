// Phone-first "share this room" logic, extracted from Room.tsx so it can be
// unit-tested in the Node client project (no jsdom) by stubbing `navigator`.
//
// The original handler was `void navigator.clipboard?.writeText(url)` — on
// mobile Safari `writeText` rejects with "Write permission denied" and the
// `void` swallowed it, so the button was a silent no-op ("not clickable").
// The rewrite tries, in order: the native share sheet (ideal on a phone —
// the host texts/AirDrops the link), then a clipboard copy with a visible
// success toast, then a visible manual-copy fallback. It never fails silently.

/** Feedback surface injected by the caller so this stays DOM-free and
 * testable. `success`/`info` map to sonner toasts in Room.tsx; `manual`
 * surfaces the raw URL for long-press copy when nothing automatic worked. */
export interface ShareLinkFeedback {
  success: (message: string) => void;
  manual: (url: string) => void;
}

/** Minimal shape of the parts of `navigator` we touch — lets the unit test
 * pass a stub without a full DOM. */
export interface ShareNavigator {
  share?: (data: { title?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText?: (text: string) => Promise<void> };
}

function isAbortError(err: unknown): boolean {
  // User dismissed the native share sheet — an explicit cancel, NOT a
  // failure, so it must be swallowed silently (no toast, no fallback).
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Share/copy a room link, degrading gracefully. Returns the outcome so the
 * caller (and tests) can assert what happened without inspecting toasts.
 *   "shared"    — native share sheet completed.
 *   "cancelled" — user dismissed the share sheet (no feedback shown).
 *   "copied"    — clipboard write succeeded (success toast shown).
 *   "manual"    — everything automatic failed; URL surfaced for manual copy.
 */
export async function shareOrCopyLink(
  url: string,
  feedback: ShareLinkFeedback,
  nav: ShareNavigator = typeof navigator !== "undefined" ? navigator : {},
): Promise<"shared" | "cancelled" | "copied" | "manual"> {
  if (typeof nav.share === "function") {
    try {
      await nav.share({ title: "Join my Mafia game", url });
      return "shared";
    } catch (err) {
      if (isAbortError(err)) return "cancelled";
      // A real share failure (permission, not-allowed) falls through to the
      // clipboard attempt below rather than dead-ending.
    }
  }

  if (typeof nav.clipboard?.writeText === "function") {
    try {
      await nav.clipboard.writeText(url);
      feedback.success("Link copied!");
      return "copied";
    } catch {
      // Clipboard denied (common on mobile Safari) — fall through to manual.
    }
  }

  feedback.manual(url);
  return "manual";
}
