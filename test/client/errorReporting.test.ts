// Spec 17 D3 — client error reporting. Same split/rationale as
// WakeLockManager/RoomConnection: no jsdom in this client test project, so
// `ErrorReporter`/`installGlobalErrorHandlers` are plain classes/functions
// constructed with a hand-rolled `navigator`/`window` surface, not a
// rendered component (the React ErrorBoundary itself is intentionally
// untested here — see its file header).
import { describe, expect, test } from "vitest";
import {
  ErrorReporter,
  installGlobalErrorHandlers,
  roomCodeFromPathname,
  truncateStackHead,
  type BeaconLike,
  type FetchLike,
} from "../../src/client/net/errorReporting";

function makeBeacon(result: boolean | undefined): { beacon: BeaconLike; calls: [string, string][] } {
  const calls: [string, string][] = [];
  const beacon: BeaconLike =
    result === undefined
      ? {}
      : {
          sendBeacon: (url: string, data: string) => {
            calls.push([url, data]);
            return result;
          },
        };
  return { beacon, calls };
}

function makeFetch(): { fetchImpl: FetchLike; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push([url, init]);
    return Promise.resolve({ ok: true });
  };
  return { fetchImpl, calls };
}

describe("roomCodeFromPathname", () => {
  test("extracts and uppercases the code from a room path", () => {
    expect(roomCodeFromPathname("/room/abcde")).toBe("ABCDE");
    expect(roomCodeFromPathname("/room/ABCDE/")).toBe("ABCDE");
  });

  test("returns undefined for non-room paths", () => {
    expect(roomCodeFromPathname("/")).toBeUndefined();
    expect(roomCodeFromPathname("/api/rooms")).toBeUndefined();
  });

  test("returns undefined for malformed room paths while preserving not-found codes", () => {
    expect(roomCodeFromPathname("/room/%ZZ")).toBeUndefined();
    expect(roomCodeFromPathname("/room/AAAAI")).toBe("AAAAI");
  });
});

describe("truncateStackHead", () => {
  test("passes short stacks through unchanged", () => {
    expect(truncateStackHead("short stack")).toBe("short stack");
  });

  test("truncates to the 4KB cap", () => {
    const long = "x".repeat(5000);
    const truncated = truncateStackHead(long);
    expect(truncated.length).toBe(4096);
  });
});

describe("ErrorReporter", () => {
  test("sends via sendBeacon when available and successful", () => {
    const { beacon, calls } = makeBeacon(true);
    const { fetchImpl, calls: fetchCalls } = makeFetch();
    const reporter = new ErrorReporter(beacon, fetchImpl);

    reporter.report("onerror", { message: "boom", url: "https://x/room/ABCDE", roomCode: "ABCDE", ua: "test-ua" });

    expect(calls).toHaveLength(1);
    expect(fetchCalls).toHaveLength(0);
    const [url, body] = calls[0]!;
    expect(url).toBe("/api/client-error");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed).toMatchObject({ kind: "onerror", message: "boom", roomCode: "ABCDE", ua: "test-ua" });
  });

  test("falls back to fetch when sendBeacon returns false", () => {
    const { beacon, calls } = makeBeacon(false);
    const { fetchImpl, calls: fetchCalls } = makeFetch();
    const reporter = new ErrorReporter(beacon, fetchImpl);

    reporter.report("onerror", { message: "boom", url: "https://x", ua: "test-ua" });

    expect(calls).toHaveLength(1); // sendBeacon was attempted
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]![0]).toBe("/api/client-error");
  });

  test("falls back to fetch when sendBeacon is unavailable", () => {
    const { beacon } = makeBeacon(undefined);
    const { fetchImpl, calls: fetchCalls } = makeFetch();
    const reporter = new ErrorReporter(beacon, fetchImpl);

    reporter.report("unhandledrejection", { message: "rejected", url: "https://x", ua: "test-ua" });

    expect(fetchCalls).toHaveLength(1);
  });

  test("omits roomCode entirely when not provided", () => {
    const { beacon, calls } = makeBeacon(true);
    const reporter = new ErrorReporter(beacon, makeFetch().fetchImpl);

    reporter.report("boundary", { message: "boom", url: "https://x", ua: "test-ua" });

    const parsed = JSON.parse(calls[0]![1]) as Record<string, unknown>;
    expect(parsed.roomCode).toBeUndefined();
    expect("roomCode" in parsed).toBe(false);
  });

  test("caps reports at 5 per page load", () => {
    const { beacon, calls } = makeBeacon(true);
    const reporter = new ErrorReporter(beacon, makeFetch().fetchImpl);

    for (let i = 0; i < 10; i++) {
      reporter.report("onerror", { message: `err-${i}`, url: "https://x", ua: "test-ua" });
    }

    expect(calls).toHaveLength(5);
  });

  test("truncates the stack to stackHead before sending", () => {
    const { beacon, calls } = makeBeacon(true);
    const reporter = new ErrorReporter(beacon, makeFetch().fetchImpl);
    const longStack = "y".repeat(5000);

    reporter.report("onerror", { message: "boom", stack: longStack, url: "https://x", ua: "test-ua" });

    const parsed = JSON.parse(calls[0]![1]) as Record<string, unknown>;
    expect((parsed.stackHead as string).length).toBe(4096);
  });

  test("never throws even if sendBeacon and fetch both throw", () => {
    const beacon: BeaconLike = {
      sendBeacon: () => {
        throw new Error("beacon exploded");
      },
    };
    const fetchImpl: FetchLike = () => {
      throw new Error("fetch exploded");
    };
    const reporter = new ErrorReporter(beacon, fetchImpl);

    expect(() => reporter.report("onerror", { message: "boom", url: "https://x", ua: "test-ua" })).not.toThrow();
  });
});

describe("installGlobalErrorHandlers", () => {
  function makeFakeWindow(pathname: string) {
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    const win = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        (listeners[type] ??= []).push(listener);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
      },
      location: { pathname, href: `https://x${pathname}` },
      navigator: { userAgent: "test-ua" },
    };
    return { win, fire: (type: string, event: unknown) => listeners[type]?.forEach((l) => l(event)) };
  }

  test("reports a window.onerror event with the room code from the path", () => {
    const { win, fire } = makeFakeWindow("/room/ABCDE");
    const { beacon, calls } = makeBeacon(true);
    const reporter = new ErrorReporter(beacon, makeFetch().fetchImpl);

    installGlobalErrorHandlers(win, reporter);
    fire("error", { message: "window blew up", error: { stack: "stack trace" } });

    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(calls[0]![1]) as Record<string, unknown>;
    expect(parsed).toMatchObject({ kind: "onerror", message: "window blew up", roomCode: "ABCDE" });
  });

  test("redacts query and fragment data from global error URLs", () => {
    const { win, fire } = makeFakeWindow("/room/ABCDE");
    win.location.href = "https://x/room/ABCDE?token=secret#private";
    const { beacon, calls } = makeBeacon(true);
    const reporter = new ErrorReporter(beacon, makeFetch().fetchImpl);

    installGlobalErrorHandlers(win, reporter);
    fire("error", { message: "window blew up" });

    const parsed = JSON.parse(calls[0]![1]) as Record<string, unknown>;
    expect(parsed.url).toBe("https://x/room/ABCDE");
  });

  test("reports an unhandledrejection with the Error's message/stack", () => {
    const { win, fire } = makeFakeWindow("/");
    const { beacon, calls } = makeBeacon(true);
    const reporter = new ErrorReporter(beacon, makeFetch().fetchImpl);

    installGlobalErrorHandlers(win, reporter);
    fire("unhandledrejection", { reason: new Error("rejected promise") });

    const parsed = JSON.parse(calls[0]![1]) as Record<string, unknown>;
    expect(parsed).toMatchObject({ kind: "unhandledrejection", message: "rejected promise" });
    expect(parsed.roomCode).toBeUndefined();
  });

  test("reports a non-Error rejection reason by stringifying it", () => {
    const { win, fire } = makeFakeWindow("/");
    const { beacon, calls } = makeBeacon(true);
    const reporter = new ErrorReporter(beacon, makeFetch().fetchImpl);

    installGlobalErrorHandlers(win, reporter);
    fire("unhandledrejection", { reason: "just a string reason" });

    const parsed = JSON.parse(calls[0]![1]) as Record<string, unknown>;
    expect(parsed.message).toBe("just a string reason");
  });

  test("teardown removes both listeners", () => {
    const { win, fire } = makeFakeWindow("/");
    const { beacon, calls } = makeBeacon(true);
    const reporter = new ErrorReporter(beacon, makeFetch().fetchImpl);

    const teardown = installGlobalErrorHandlers(win, reporter);
    teardown();
    fire("error", { message: "should not be reported" });
    fire("unhandledrejection", { reason: "should not be reported" });

    expect(calls).toHaveLength(0);
  });
});
