// Regression coverage for the hotfix to the "Share link" button's silent
// no-op (docs/specs/HOTFIX-lobby-notes.md). The old handler was
// `void navigator.clipboard?.writeText(url)`: on mobile Safari `writeText`
// rejects with "Write permission denied" and `void` swallowed it, so the
// button did nothing. `shareOrCopyLink` must NEVER dead-end — it degrades
// share sheet -> clipboard+toast -> visible manual-copy fallback.
//
// Same environment posture as RoomConnection.test.ts: no jsdom, so this
// stubs only the tiny `navigator` surface the helper touches.
import { describe, expect, test, vi } from "vitest";
import { shareOrCopyLink, type ShareNavigator } from "../../src/client/lib/shareLink";

function makeFeedback() {
  return {
    success: vi.fn<(m: string) => void>(),
    manual: vi.fn<(u: string) => void>(),
  };
}

const URL = "https://mafia.example/room/ABCDE";

describe("shareOrCopyLink", () => {
  test("uses the native share sheet when available", async () => {
    const fb = makeFeedback();
    const share = vi.fn(async () => {});
    const nav: ShareNavigator = { share };

    const result = await shareOrCopyLink(URL, fb, nav);

    expect(result).toBe("shared");
    expect(share).toHaveBeenCalledWith({ title: "Join my Mafia game", url: URL });
    expect(fb.success).not.toHaveBeenCalled();
    expect(fb.manual).not.toHaveBeenCalled();
  });

  test("treats a cancelled share sheet (AbortError) as a silent non-failure", async () => {
    const fb = makeFeedback();
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const clipboard = { writeText: vi.fn(async () => {}) };
    const nav: ShareNavigator = {
      share: vi.fn(async () => {
        throw abort;
      }),
      clipboard,
    };

    const result = await shareOrCopyLink(URL, fb, nav);

    // User dismissed the sheet on purpose — do NOT then copy or show a
    // fallback (that would be surprising after an explicit cancel).
    expect(result).toBe("cancelled");
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(fb.success).not.toHaveBeenCalled();
    expect(fb.manual).not.toHaveBeenCalled();
  });

  test("falls back to clipboard + success toast when share is unavailable", async () => {
    const fb = makeFeedback();
    const clipboard = { writeText: vi.fn(async () => {}) };
    const nav: ShareNavigator = { clipboard };

    const result = await shareOrCopyLink(URL, fb, nav);

    expect(result).toBe("copied");
    expect(clipboard.writeText).toHaveBeenCalledWith(URL);
    expect(fb.success).toHaveBeenCalledWith("Link copied!");
    expect(fb.manual).not.toHaveBeenCalled();
  });

  test("falls back to clipboard when a non-abort share error is thrown", async () => {
    const fb = makeFeedback();
    const clipboard = { writeText: vi.fn(async () => {}) };
    const nav: ShareNavigator = {
      share: vi.fn(async () => {
        throw Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
      }),
      clipboard,
    };

    const result = await shareOrCopyLink(URL, fb, nav);

    expect(result).toBe("copied");
    expect(clipboard.writeText).toHaveBeenCalledWith(URL);
    expect(fb.success).toHaveBeenCalledWith("Link copied!");
  });

  test("surfaces the URL for manual copy when clipboard rejects and share is unavailable (mobile Safari)", async () => {
    const fb = makeFeedback();
    const clipboard = {
      writeText: vi.fn(async () => {
        throw new Error("Write permission denied");
      }),
    };
    const nav: ShareNavigator = { clipboard };

    const result = await shareOrCopyLink(URL, fb, nav);

    // The critical assertion: NOT a silent no-op — the URL is surfaced.
    expect(result).toBe("manual");
    expect(fb.manual).toHaveBeenCalledWith(URL);
    expect(fb.success).not.toHaveBeenCalled();
  });

  test("surfaces the URL for manual copy when neither share nor clipboard exist", async () => {
    const fb = makeFeedback();
    const nav: ShareNavigator = {};

    const result = await shareOrCopyLink(URL, fb, nav);

    expect(result).toBe("manual");
    expect(fb.manual).toHaveBeenCalledWith(URL);
  });
});
