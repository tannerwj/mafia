// Regression coverage for the reconnect-cycling bug found in Spec 04's
// fix-round-4 (docs/specs/04-implementation-notes.md): `RoomConnection`
// had no per-socket generation identity, so a stale (already-superseded)
// socket's own asynchronous `close` event could fire after `forceRecycle()`
// had already installed a newer, healthy socket — and unconditionally wrote
// `this.ws = null` over it, silently breaking `send()` on the live
// connection. From the outside this looked like the reconnect banner never
// clearing / cycling indefinitely.
//
// No `jsdom` (not in the dependency budget) — `RoomConnection` only touches
// a small, easily-stubbed surface of `window`/`document`/`location`/
// `WebSocket`, so this hand-rolls exactly that surface as plain globals and
// runs in vitest's default `node` environment. See `tsconfig.client-test
// .json` for the DOM-lib typing this file needs (matching the same lib set
// `src/client` itself typechecks under).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  private listeners: Record<string, ((event: any) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  static instances: FakeWebSocket[] = [];

  addEventListener(type: string, listener: (event: any) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("send on non-open socket");
    this.sent.push(data);
  }

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
    // Real WebSocket close handshakes are asynchronous — model that with a
    // queued microtask/macrotask rather than firing `close` synchronously,
    // so tests can control exactly when a stale socket's `close` lands
    // relative to a newer socket's lifecycle (the crux of the bug).
    this.pendingCloseCode = code;
  }

  pendingCloseCode: number | null = null;

  /** Test control: simulate the server accepting the connection. */
  fakeOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    for (const l of this.listeners.open ?? []) l({});
  }

  /** Test control: simulate a message frame arriving. */
  fakeMessage(data: unknown): void {
    for (const l of this.listeners.message ?? []) l({ data: JSON.stringify(data) });
  }

  /** Test control: actually deliver the (possibly long-delayed) close event
   * for a `close()` call that was issued earlier — this is the async gap a
   * real browser has between `.close()` and the `close` event firing. */
  fakeDeliverClose(code = this.pendingCloseCode ?? 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const l of this.listeners.close ?? []) l({ code });
  }
}

function installFakeBrowserGlobals() {
  FakeWebSocket.instances = [];
  const listeners: Record<string, ((event: any) => void)[]> = {};
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).window = {
    addEventListener: (type: string, fn: (e: any) => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: (e: any) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
    },
  };
  (globalThis as any).document = { visibilityState: "visible" };
  (globalThis as any).location = { protocol: "http:", host: "localhost:5173" };
}

describe("RoomConnection reconnect generation guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeBrowserGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a stale socket's delayed close event does not clobber a newer socket installed by forceRecycle", async () => {
    const { RoomConnection } = await import("../../src/client/net/RoomConnection");

    const statuses: string[] = [];
    const conn = new RoomConnection(
      "ABCDE",
      { kind: "join", name: "Alice" },
      { onStatusChange: (s) => statuses.push(s) },
    );

    // First socket connects and opens normally.
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socketA = FakeWebSocket.instances[0]!;
    socketA.fakeOpen();
    expect(socketA.sent).toHaveLength(1);
    expect(JSON.parse(socketA.sent[0]!)).toMatchObject({ type: "hello" });

    // Never send `welcome`/`pong` on socket A — its `lastMessageAt` stays
    // frozen at open time, exactly like the real "hello never gets a
    // response" scenario this bug was found from. The 5s auth-response
    // timeout (see the dedicated test below) fires well before the 40s
    // liveness timeout would — either path calls `forceRecycle()`, which is
    // exactly the scenario under test here (a stale socket outliving its
    // own supersession), so advancing well past both is deliberate.
    await vi.advanceTimersByTimeAsync(45_000);

    // forceRecycle() called ws.close() (still pending — not yet delivered)
    // and installed socket B synchronously.
    expect(FakeWebSocket.instances).toHaveLength(2);
    const socketB = FakeWebSocket.instances[1]!;
    expect(socketA.pendingCloseCode).not.toBeNull();
    expect(socketA.readyState).toBe(FakeWebSocket.CLOSING);

    // Socket B opens and authenticates successfully.
    socketB.fakeOpen();
    socketB.fakeMessage({ type: "welcome", you: { isHost: false, playerId: "p1" }, state: {}, serverNow: Date.now() });
    expect(statuses.at(-1)).toBe("open");

    // NOW the stale socket A's close event finally lands, long after B took
    // over. Before the generation-guard fix, this unconditionally set
    // `this.ws = null`, silently breaking `send()` on the still-healthy
    // socket B — from the outside indistinguishable from an endless
    // reconnect cycle.
    socketA.fakeDeliverClose(1006);

    // Socket B must still be the live connection: sending must actually
    // reach it, and the connection must still report "open", not have been
    // knocked back into "reconnecting" by the stale event.
    expect(statuses.at(-1)).toBe("open");
    conn.send({ type: "ping" });
    expect(socketB.sent.some((m) => JSON.parse(m).type === "ping")).toBe(true);

    // No spurious third socket should have been created by the stale
    // close's (pre-fix) call into `scheduleReconnect()`.
    expect(FakeWebSocket.instances).toHaveLength(2);

    conn.close();
  });

  test("the socket that is actually current still reconnects normally on its own close", async () => {
    const { RoomConnection } = await import("../../src/client/net/RoomConnection");

    const statuses: string[] = [];
    const conn = new RoomConnection(
      "ABCDE",
      { kind: "join", name: "Bob" },
      { onStatusChange: (s) => statuses.push(s) },
    );

    const socketA = FakeWebSocket.instances[0]!;
    socketA.fakeOpen();
    socketA.fakeMessage({ type: "welcome", you: { isHost: false, playerId: "p1" }, state: {}, serverNow: Date.now() });
    expect(statuses.at(-1)).toBe("open");

    // A genuine drop of the CURRENT socket must still reconnect normally —
    // the generation guard must not suppress legitimate reconnects, only
    // stale ones.
    socketA.close();
    socketA.fakeDeliverClose(1006);
    expect(statuses.at(-1)).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const socketB = FakeWebSocket.instances[1]!;
    socketB.fakeOpen();
    socketB.fakeMessage({ type: "welcome", you: { isHost: false, playerId: "p1" }, state: {}, serverNow: Date.now() });
    expect(statuses.at(-1)).toBe("open");

    conn.close();
  });

  test("a hello that gets no welcome/error response within 5s is recycled immediately, without waiting for the server's 30s auth-reap", async () => {
    const { RoomConnection } = await import("../../src/client/net/RoomConnection");

    const statuses: string[] = [];
    const conn = new RoomConnection(
      "ABCDE",
      { kind: "join", name: "Carol" },
      { onStatusChange: (s) => statuses.push(s) },
    );

    const socketA = FakeWebSocket.instances[0]!;
    socketA.fakeOpen();
    expect(JSON.parse(socketA.sent[0]!)).toMatchObject({ type: "hello" });

    // No welcome, no error, no pong -- just silence. A fresh socket must be
    // installed at the 5s auth-response timeout, well before the 30s the
    // server would take to reap the stale pending-auth entry, and before
    // the 40s client-side liveness timeout would otherwise have caught it.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const socketB = FakeWebSocket.instances[1]!;
    expect(socketB).not.toBe(socketA);

    socketB.fakeOpen();
    socketB.fakeMessage({ type: "welcome", you: { isHost: false, playerId: "p1" }, state: {}, serverNow: Date.now() });
    expect(statuses.at(-1)).toBe("open");

    conn.close();
  });

  test("an error response to hello (e.g. a stale join credential rejected as game_in_progress) cancels the auth-response timeout instead of double-recycling", async () => {
    const { RoomConnection } = await import("../../src/client/net/RoomConnection");

    const conn = new RoomConnection(
      "ABCDE",
      { kind: "join", name: "Dave" },
      {},
    );

    const socketA = FakeWebSocket.instances[0]!;
    socketA.fakeOpen();
    socketA.fakeMessage({ type: "error", code: "game_in_progress", message: "Cannot join once the game has started." });

    // The error already answered this socket's `hello` -- advancing past
    // the 5s auth-response window must NOT trigger a second, redundant
    // recycle on top of whatever the caller does with the error.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    conn.close();
  });
});
