// Spec 14 (docs/specs/14-wake-lock.md): `WakeLockManager` owns the actual
// request/release/re-request lifecycle; `useWakeLock` is thin React glue
// over it (untested here, same split as hostRoleCounts.ts/HostLobby.tsx —
// see that file's header for why: no jsdom/testing-library in this client
// test project, so anything unit-tested has to be plain-class logic
// constructed with a hand-rolled navigator/document, not a rendered hook).
import { describe, expect, test, vi } from "vitest";
import {
  WakeLockManager,
  type WakeLockDocumentLike,
  type WakeLockNavigatorLike,
  type WakeLockSentinelLike,
} from "../../src/client/net/wakeLock";

/** A fake sentinel whose `release()` can be observed and which supports
 * exactly the `release` event the manager listens for. */
function makeFakeSentinel() {
  const listeners: (() => void)[] = [];
  const release = vi.fn(async () => {
    for (const l of listeners.splice(0)) l();
  });
  const sentinel: WakeLockSentinelLike = {
    release,
    addEventListener: (_type, fn) => listeners.push(fn),
    removeEventListener: (_type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return { sentinel, release, emitRelease: () => listeners.slice().forEach((l) => l()) };
}

type RequestFn = (type: "screen") => Promise<WakeLockSentinelLike>;

function makeFakeNavigator(requestImpl: RequestFn): WakeLockNavigatorLike {
  return { wakeLock: { request: requestImpl } };
}

function makeFakeDocument(initial: "visible" | "hidden" = "visible") {
  const listeners: (() => void)[] = [];
  const doc: WakeLockDocumentLike & { visibilityState: "visible" | "hidden" } = {
    visibilityState: initial,
    addEventListener: (_type, fn) => listeners.push(fn),
    removeEventListener: (_type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return { doc, fireVisibilityChange: () => listeners.slice().forEach((l) => l()) };
}

describe("WakeLockManager", () => {
  test("requests a lock when activated", async () => {
    const { sentinel } = makeFakeSentinel();
    const request = vi.fn(async () => sentinel);
    const nav = makeFakeNavigator(request);
    const { doc } = makeFakeDocument("visible");

    const manager = new WakeLockManager(nav, doc);
    manager.setActive(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
  });

  test("re-acquires on visibilitychange back to visible", async () => {
    let call = 0;
    const sentinels = [makeFakeSentinel(), makeFakeSentinel()];
    const request = vi.fn(async () => sentinels[call++]!.sentinel);
    const nav = makeFakeNavigator(request);
    const { doc, fireVisibilityChange } = makeFakeDocument("visible");

    const manager = new WakeLockManager(nav, doc);
    manager.setActive(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);

    // The UA auto-releases the sentinel when the page goes hidden (firing
    // the sentinel's own `release` event) AND fires `visibilitychange` —
    // simulate both, in that order, same as a real browser.
    doc.visibilityState = "hidden";
    sentinels[0]!.emitRelease();
    fireVisibilityChange();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1); // no re-request while hidden

    doc.visibilityState = "visible";
    fireVisibilityChange();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
  });

  test("re-acquires when the sentinel's own release event fires while visible and active", async () => {
    let call = 0;
    const sentinels = [makeFakeSentinel(), makeFakeSentinel()];
    const request = vi.fn(async () => sentinels[call++]!.sentinel);
    const nav = makeFakeNavigator(request);
    const { doc } = makeFakeDocument("visible");

    const manager = new WakeLockManager(nav, doc);
    manager.setActive(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);

    // UA revokes the lock on its own, outside the visibility path.
    sentinels[0]!.emitRelease();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
  });

  test("does not re-acquire on visibilitychange when inactive", async () => {
    const { sentinel } = makeFakeSentinel();
    const request = vi.fn(async () => sentinel);
    const nav = makeFakeNavigator(request);
    const { doc, fireVisibilityChange } = makeFakeDocument("visible");

    void new WakeLockManager(nav, doc);
    // Never activated.
    fireVisibilityChange();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
  });

  test("does not re-acquire on a visibilitychange event that fires while still hidden", async () => {
    const { sentinel } = makeFakeSentinel();
    const request = vi.fn(async () => sentinel);
    const nav = makeFakeNavigator(request);
    const { doc, fireVisibilityChange } = makeFakeDocument("hidden");

    const manager = new WakeLockManager(nav, doc);
    manager.setActive(true);
    await Promise.resolve();
    await Promise.resolve();
    // Activated while hidden: request() is attempted regardless (the UA is
    // the one that ultimately rejects/no-ops if it wants to gate on
    // visibility) — but a *redundant* visibilitychange firing while still
    // hidden must not trigger a second one.
    const callsAfterActivate = request.mock.calls.length;

    fireVisibilityChange(); // still "hidden" — no transition
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(callsAfterActivate);
  });

  test("releases the lock on deactivate", async () => {
    const { sentinel, release } = makeFakeSentinel();
    const request = vi.fn(async () => sentinel);
    const nav = makeFakeNavigator(request);
    const { doc } = makeFakeDocument("visible");

    const manager = new WakeLockManager(nav, doc);
    manager.setActive(true);
    await Promise.resolve();
    await Promise.resolve();

    manager.setActive(false);
    await Promise.resolve();

    expect(release).toHaveBeenCalledTimes(1);
  });

  test("releases the lock and removes listeners on dispose", async () => {
    let call = 0;
    const sentinels = [makeFakeSentinel(), makeFakeSentinel()];
    const request = vi.fn(async () => sentinels[call++]!.sentinel);
    const nav = makeFakeNavigator(request);
    const { doc, fireVisibilityChange } = makeFakeDocument("visible");

    const manager = new WakeLockManager(nav, doc);
    manager.setActive(true);
    await Promise.resolve();
    await Promise.resolve();

    manager.dispose();
    await Promise.resolve();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);

    // After dispose, a visibilitychange must do nothing — listener removed.
    doc.visibilityState = "hidden";
    fireVisibilityChange();
    doc.visibilityState = "visible";
    fireVisibilityChange();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
  });

  test("is silent when navigator.wakeLock is missing (old browsers)", async () => {
    const nav: WakeLockNavigatorLike = {};
    const { doc, fireVisibilityChange } = makeFakeDocument("visible");

    const manager = new WakeLockManager(nav, doc);
    expect(() => manager.setActive(true)).not.toThrow();
    await Promise.resolve();

    fireVisibilityChange();
    await Promise.resolve();
    manager.dispose();
    // Nothing to assert beyond "never throws" — there's no request fn to spy
    // on, which is the point (feature-detected away entirely).
  });

  test("is silent when request() rejects (e.g. NotAllowedError)", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    });
    const nav = makeFakeNavigator(request);
    const { doc } = makeFakeDocument("visible");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const manager = new WakeLockManager(nav, doc);
    expect(() => manager.setActive(true)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    debugSpy.mockRestore();
  });

  test("does not issue a second in-flight request when toggled rapidly (setActive true/false/true before the first request resolves)", async () => {
    let resolveRequest: ((s: WakeLockSentinelLike) => void) | null = null;
    const { sentinel } = makeFakeSentinel();
    const request = vi.fn(
      () =>
        new Promise<WakeLockSentinelLike>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const nav = makeFakeNavigator(request);
    const { doc } = makeFakeDocument("visible");

    const manager = new WakeLockManager(nav, doc);
    manager.setActive(true);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);

    // Toggle off then on again while the first request is still pending.
    manager.setActive(false);
    manager.setActive(true);
    await Promise.resolve();

    // Still only one in-flight request — guarded by `requesting`.
    expect(request).toHaveBeenCalledTimes(1);

    resolveRequest!(sentinel);
    await Promise.resolve();
    await Promise.resolve();

    // The manager ends active, so the resolved sentinel should be kept, not
    // released as a stale grant.
    expect(sentinel.release).not.toHaveBeenCalled();
  });

  test("releases a lock that resolves after setActive(false) was called (stale grant)", async () => {
    let resolveRequest: ((s: WakeLockSentinelLike) => void) | null = null;
    const { sentinel, release } = makeFakeSentinel();
    const request = vi.fn(
      () =>
        new Promise<WakeLockSentinelLike>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const nav = makeFakeNavigator(request);
    const { doc } = makeFakeDocument("visible");

    const manager = new WakeLockManager(nav, doc);
    manager.setActive(true);
    await Promise.resolve();
    manager.setActive(false);

    resolveRequest!(sentinel);
    await Promise.resolve();
    await Promise.resolve();

    expect(release).toHaveBeenCalledTimes(1);
  });

  test("setActive with the same value twice does not issue a second request", async () => {
    const { sentinel } = makeFakeSentinel();
    const request = vi.fn(async () => sentinel);
    const nav = makeFakeNavigator(request);
    const { doc } = makeFakeDocument("visible");

    const manager = new WakeLockManager(nav, doc);
    manager.setActive(true);
    manager.setActive(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
  });
});
