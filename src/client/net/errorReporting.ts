// Spec 17 D3 — client error reporting. Plain, dependency-injected logic
// (same split as `WakeLockManager`/`useWakeLock` — this client test project
// has no jsdom/testing-library, so anything unit-tested has to be
// exercisable by stubbing the small `navigator`/`window` surface it actually
// touches, not by rendering a component).
//
// `ErrorReporter` owns the per-page-load report cap and the actual
// beacon-or-fetch send; `installGlobalErrorHandlers` wires `window.onerror`
// + `unhandledrejection` to it (module scope, once); the React
// `ErrorBoundary` component calls `reporter.report("boundary", ...)`
// directly from `componentDidCatch`.
export type ClientErrorKind = "boundary" | "onerror" | "unhandledrejection";

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stackHead: string;
  url: string;
  roomCode?: string;
  ua: string;
}

const MAX_REPORTS_PER_PAGE_LOAD = 5;
const STACK_HEAD_MAX_BYTES = 4 * 1024;
const CLIENT_ERROR_ENDPOINT = "/api/client-error";

export interface BeaconLike {
  sendBeacon?(url: string, data: string): boolean;
}

export interface FetchLike {
  (input: string, init: { method: string; body: string; headers: Record<string, string>; keepalive?: boolean }): unknown;
}

/** Truncates to at most `STACK_HEAD_MAX_BYTES` UTF-16 code units — a simple,
 * fast approximation of a byte cap that's good enough for a diagnostic
 * stack head (never used for anything security-sensitive). */
export function truncateStackHead(stack: string): string {
  return stack.length > STACK_HEAD_MAX_BYTES ? stack.slice(0, STACK_HEAD_MAX_BYTES) : stack;
}

/** Parses a room code from a pathname, mirroring `useRoute`'s regex exactly
 * (kept independent so this module never needs to import React glue). */
export function roomCodeFromPathname(pathname: string): string | undefined {
  const match = /^\/room\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    const code = decodeURIComponent(match[1]!).toUpperCase();
    return /^[A-Z0-9]{5}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function diagnosticUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://mafia.invalid");
    parsed.search = "";
    parsed.hash = "";
    return url.startsWith("/") ? parsed.pathname : parsed.toString();
  } catch {
    const query = url.search(/[?#]/);
    return url.slice(0, Math.min(query < 0 ? url.length : query, 2048));
  }
}

let sharedReporter: ErrorReporter | null = null;

/** The one `ErrorReporter` instance for the page — shared by
 * `installGlobalErrorHandlers` (main.tsx) and `ErrorBoundary` so the
 * per-page-load cap of 5 (spec-pinned) is tracked across BOTH report
 * sources, not double-counted by two independent instances. */
export function getSharedReporter(): ErrorReporter {
  if (!sharedReporter) {
    sharedReporter = new ErrorReporter(
      { sendBeacon: navigator.sendBeacon?.bind(navigator) },
      (url, init) => fetch(url, init),
    );
  }
  return sharedReporter;
}

export class ErrorReporter {
  private sentCount = 0;

  constructor(
    private readonly beacon: BeaconLike,
    private readonly fetchImpl: FetchLike,
  ) {}

  /** Sends one report, subject to the per-page-load cap. Never throws —
   * error reporting must never itself become a source of errors. */
  report(
    kind: ClientErrorKind,
    fields: { message: string; stack?: string | undefined; url: string; roomCode?: string | undefined; ua: string },
  ): void {
    if (this.sentCount >= MAX_REPORTS_PER_PAGE_LOAD) return;
    this.sentCount++;

    const body: ClientErrorReport = {
      kind,
      message: fields.message,
      stackHead: truncateStackHead(fields.stack ?? ""),
      url: fields.url,
      ua: fields.ua,
      ...(fields.roomCode ? { roomCode: fields.roomCode } : {}),
    };

    try {
      const json = JSON.stringify(body);
      const sent = this.beacon.sendBeacon?.(CLIENT_ERROR_ENDPOINT, json);
      if (!sent) {
        void Promise.resolve(
          this.fetchImpl(CLIENT_ERROR_ENDPOINT, {
            method: "POST",
            body: json,
            headers: { "content-type": "application/json" },
            keepalive: true,
          }),
        ).catch(() => {
          // Best-effort — nothing to do if even the fetch fallback fails.
        });
      }
    } catch {
      // Never let error reporting throw.
    }
  }
}

/** Wires `window.onerror` + `unhandledrejection` to `reporter`, once, at
 * module/app scope. Returns a teardown function (used by tests; the real
 * app calls this once at startup and never tears it down). */
export function installGlobalErrorHandlers(
  win: {
    addEventListener(type: "error" | "unhandledrejection", listener: (event: unknown) => void): void;
    removeEventListener(type: "error" | "unhandledrejection", listener: (event: unknown) => void): void;
    location: { pathname: string; href: string };
    navigator: { userAgent: string };
  },
  reporter: ErrorReporter,
): () => void {
  const onError = (event: unknown) => {
    const e = event as { message?: string; error?: { stack?: string } };
    reporter.report("onerror", {
      message: typeof e.message === "string" ? e.message : "Unknown error",
      stack: e.error?.stack,
      url: diagnosticUrl(win.location.href),
      roomCode: roomCodeFromPathname(win.location.pathname),
      ua: win.navigator.userAgent,
    });
  };

  const onUnhandledRejection = (event: unknown) => {
    const e = event as { reason?: unknown };
    const reason = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    reporter.report("unhandledrejection", {
      message,
      stack,
      url: diagnosticUrl(win.location.href),
      roomCode: roomCodeFromPathname(win.location.pathname),
      ua: win.navigator.userAgent,
    });
  };

  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
