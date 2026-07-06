// Spec 14: screen wake lock. Split into a plain, dependency-injected manager
// class (this file) plus a thin `useWakeLock` hook (Room.tsx) for the same
// reason RoomConnection is a plain class — this repo's client tests run in
// plain Node with no jsdom/testing-library (see RoomConnection.test.ts), so
// anything that needs unit coverage has to be exercisable by stubbing the
// tiny `navigator`/`document` surface it actually touches, not by rendering
// a component.
//
// The Screen Wake Lock API: `navigator.wakeLock.request("screen")` returns a
// sentinel that the UA auto-releases when the page becomes hidden. There is
// no re-request API — getting the lock back after the page returns to
// visible means calling `request()` again, which is exactly what
// `handleVisibilityChange` below does.
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

export interface WakeLockNavigatorLike {
  wakeLock?: {
    request(type: "screen"): Promise<WakeLockSentinelLike>;
  };
}

export interface WakeLockDocumentLike {
  visibilityState: "visible" | "hidden";
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Owns at most one wake-lock sentinel at a time. `setActive(true)` requests
 * a lock and starts watching `visibilitychange`; `setActive(false)` (or
 * `dispose()`) releases the lock and stops watching. Safe to call
 * `setActive` repeatedly with the same value (no double requests) and safe
 * to construct where `navigator.wakeLock` doesn't exist (old browsers keep
 * today's behavior, silently).
 */
export class WakeLockManager {
  private sentinel: WakeLockSentinelLike | null = null;
  private active = false;
  // Guards the re-request path against overlapping in-flight `request()`
  // calls — e.g. a rapid hidden->visible->hidden->visible flutter, or
  // `setActive(true)` while a previous request from `handleVisibilityChange`
  // hasn't resolved yet.
  private requesting = false;
  private readonly boundHandleVisibilityChange: () => void;
  private readonly boundHandleRelease: () => void;

  constructor(
    private readonly nav: WakeLockNavigatorLike,
    private readonly doc: WakeLockDocumentLike,
  ) {
    this.boundHandleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.boundHandleRelease = this.handleRelease.bind(this);
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.doc.addEventListener("visibilitychange", this.boundHandleVisibilityChange);
      void this.requestLock();
    } else {
      this.doc.removeEventListener("visibilitychange", this.boundHandleVisibilityChange);
      void this.releaseLock();
    }
  }

  /** Release the lock and stop listening entirely — call on unmount. */
  dispose(): void {
    this.setActive(false);
  }

  private async requestLock(): Promise<void> {
    if (!this.nav.wakeLock || this.sentinel || this.requesting) return;
    this.requesting = true;
    try {
      const sentinel = await this.nav.wakeLock.request("screen");
      this.requesting = false;
      // The hook may have gone inactive (or been disposed) while the
      // request was in flight — don't hold a lock nobody wants anymore.
      if (!this.active) {
        void sentinel.release();
        return;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener("release", this.boundHandleRelease);
    } catch {
      // Silent by contract: NotAllowedError (no user activation / low
      // battery on some UAs) and any other rejection are not surfaced.
      this.requesting = false;
    }
  }

  private async releaseLock(): Promise<void> {
    const sentinel = this.sentinel;
    if (!sentinel) return;
    this.sentinel = null;
    sentinel.removeEventListener("release", this.boundHandleRelease);
    try {
      await sentinel.release();
    } catch {
      // Nothing to do — the sentinel is already gone either way.
    }
  }

  private handleVisibilityChange(): void {
    if (!this.active || this.doc.visibilityState !== "visible") return;
    void this.requestLock();
  }

  /** The UA revoked the lock on its own (e.g. some UAs do this outside the
   * visibility path too) — re-request iff still active and visible. */
  private handleRelease(): void {
    this.sentinel = null;
    if (this.active && this.doc.visibilityState === "visible") {
      void this.requestLock();
    }
  }
}
