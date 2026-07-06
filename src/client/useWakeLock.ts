import { useEffect, useRef } from "react";
import type { WakeLockDocumentLike, WakeLockNavigatorLike } from "./net/wakeLock";
import { WakeLockManager } from "./net/wakeLock";

// Spec 14: keep the screen awake while `active` (the room-level component
// passes "does this session hold a live seat in a connected room"). All the
// actual request/release/re-request-on-visibilitychange logic lives in
// `WakeLockManager` (net/wakeLock.ts) — plain-class logic there is unit
// testable in this repo's jsdom-less client test project; this hook is thin
// React glue over it and is intentionally not unit tested itself (same split
// as `hostRoleCounts.ts` / `HostLobby.tsx`).
export function useWakeLock(active: boolean): void {
  const managerRef = useRef<WakeLockManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = new WakeLockManager(
      navigator as unknown as WakeLockNavigatorLike,
      document as unknown as WakeLockDocumentLike,
    );
  }

  useEffect(() => {
    managerRef.current!.setActive(active);
  }, [active]);

  useEffect(() => {
    const manager = managerRef.current!;
    return () => manager.dispose();
  }, []);
}
