// Spec 17 D3 — top-level React error boundary. "THE CASE FILE JAMMED" noir
// screen with a reload button and the room code (if the crash happened
// mid-game). `componentDidCatch` is a real React lifecycle method with no
// jsdom-less unit-test path in this repo (see net/errorReporting.ts header),
// so the reporting call itself is a single line delegating to
// `ErrorReporter` (already unit-tested) — there is nothing left here worth
// testing in isolation beyond "does it render the fallback", which needs a
// DOM this project doesn't have. Same split as `useWakeLock`.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { getSharedReporter, roomCodeFromPathname } from "../net/errorReporting";
import { Button } from "./ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = error.stack ?? info.componentStack ?? undefined;
    const roomCode = roomCodeFromPathname(window.location.pathname);
    getSharedReporter().report("boundary", {
      message: error.message,
      url: window.location.href,
      ua: navigator.userAgent,
      ...(stack ? { stack } : {}),
      ...(roomCode ? { roomCode } : {}),
    });
  }

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const roomCode = roomCodeFromPathname(window.location.pathname);
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-ink p-6 text-center">
        <h1 className="file-heading text-2xl text-blood">THE CASE FILE JAMMED</h1>
        <p className="max-w-sm text-sm text-paper/70">
          Something tore in the paperwork. The desk sergeant has been notified.
        </p>
        {roomCode ? (
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-paper/50">Case {roomCode}</p>
        ) : null}
        <Button variant="brass" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}
