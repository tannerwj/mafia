import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
  evictDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type {
  ClientMessage,
  ErrorMessage,
  PongMessage,
  ServerMessage,
  SnapshotMessage,
  WelcomeMessage,
} from "../../src/shared/protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createRoom(): Promise<{ roomCode: string; hostKey: string }> {
  const res = await SELF.fetch("https://example.com/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { roomCode: string; hostKey: string };
}

// Sockets can receive a broadcast (e.g. the post-kick snapshot to the host)
// before the test gets around to awaiting it — there's always a round trip
// or two between "the event we triggered" and "the event we're asserting
// on". A bare `addEventListener("message", ...)` attached at await-time
// would silently drop anything that arrived earlier. So every socket gets a
// single real listener from the moment it's opened, buffering into a queue;
// `nextMessage`/`nextMessageOfType` drain that queue instead of racing a
// fresh listener against the wire. Same reasoning for close events.
interface SocketQueue {
  messages: ServerMessage[];
  messageWaiters: ((msg: ServerMessage) => void)[];
  closeEvent: { code: number } | null;
  closeWaiters: ((event: { code: number }) => void)[];
}

const queues = new WeakMap<WebSocket, SocketQueue>();

function queueFor(ws: WebSocket): SocketQueue {
  let q = queues.get(ws);
  if (!q) {
    q = {
      messages: [],
      messageWaiters: [],
      closeEvent: null,
      closeWaiters: [],
    };
    queues.set(ws, q);
    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      const waiter = q!.messageWaiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        q!.messages.push(msg);
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      const closeEvent = { code: event.code };
      q!.closeEvent = closeEvent;
      for (const waiter of q!.closeWaiters.splice(0)) {
        waiter(closeEvent);
      }
    });
  }
  return q;
}

async function openSocket(roomCode: string): Promise<WebSocket> {
  const res = await SELF.fetch(
    `https://example.com/api/rooms/${roomCode}/ws`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  expect(ws).toBeDefined();
  queueFor(ws!); // start buffering before accept() so nothing is missed
  ws!.accept();
  return ws!;
}

function send(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  const q = queueFor(ws);
  const buffered = q.messages.shift();
  if (buffered) return Promise.resolve(buffered);
  return new Promise((resolve) => q.messageWaiters.push(resolve));
}

/** Like nextMessage, but skips over broadcast snapshots that can race with
 * the message under test (e.g. a snapshot fired by another socket's hello
 * landing before the reply we actually want). */
async function nextMessageOfType<T extends ServerMessage["type"]>(
  ws: WebSocket,
  type: T,
): Promise<Extract<ServerMessage, { type: T }>> {
  const q = queueFor(ws);
  for (;;) {
    const idx = q.messages.findIndex((m) => m.type === type);
    if (idx !== -1) {
      return q.messages.splice(idx, 1)[0] as Extract<
        ServerMessage,
        { type: T }
      >;
    }
    const msg = await new Promise<ServerMessage>((resolve) =>
      q.messageWaiters.push(resolve),
    );
    if (msg.type === type) {
      return msg as Extract<ServerMessage, { type: T }>;
    }
    // Not the type we want — put it back for any other pending consumer.
    q.messages.push(msg);
  }
}

function nextClose(ws: WebSocket): Promise<{ code: number }> {
  const q = queueFor(ws);
  if (q.closeEvent) return Promise.resolve(q.closeEvent);
  return new Promise((resolve) => q.closeWaiters.push(resolve));
}

async function joinAsPlayer(
  roomCode: string,
  name: string,
): Promise<{ ws: WebSocket; welcome: WelcomeMessage }> {
  const ws = await openSocket(roomCode);
  send(ws, { type: "hello", auth: { kind: "join", name } });
  const welcome = (await nextMessage(ws)) as WelcomeMessage;
  return { ws, welcome };
}

async function stubFor(roomCode: string) {
  return env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(roomCode));
}

describe("claim protocol", () => {
  test("claim then second claim on the same DO returns taken", async () => {
    const roomCode = "AAAAA";
    const stub = await stubFor(roomCode);

    const first = await stub.fetch("https://do/internal/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: roomCode }),
    });
    expect((await first.json()) as { status: string }).toMatchObject({
      status: "claimed",
    });

    const second = await stub.fetch("https://do/internal/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: roomCode }),
    });
    expect(await second.json()).toEqual({ status: "taken" });
  });
});

describe("create -> join -> snapshot", () => {
  test("full lobby happy path", async () => {
    const { roomCode, hostKey } = await createRoom();

    const hostWs = await openSocket(roomCode);
    send(hostWs, { type: "hello", auth: { kind: "host", hostKey } });
    const hostWelcome = (await nextMessage(hostWs)) as WelcomeMessage;
    expect(hostWelcome.type).toBe("welcome");
    expect(hostWelcome.you.isHost).toBe(true);
    expect(hostWelcome.state.roomCode).toBe(roomCode);
    expect(hostWelcome.state.phase).toBe("lobby");

    const { ws: playerWs, welcome } = await joinAsPlayer(roomCode, "Alice");
    expect(welcome.you.isHost).toBe(false);
    expect(welcome.you.playerId).toBeDefined();
    expect(welcome.you.seatToken).toBeDefined();
    expect(welcome.state.players).toHaveLength(1);
    expect(welcome.state.players[0]).toMatchObject({
      name: "Alice",
      isYou: true,
      connected: true,
    });

    // Host receives a broadcast snapshot reflecting the new player. Skip
    // over the host's own post-hello snapshot (0 players) that precedes it.
    const hostSnapshot = await nextMessageOfType(hostWs, "snapshot");
    expect(hostSnapshot.type).toBe("snapshot");
    expect(hostSnapshot.state.players).toHaveLength(1);
    expect(hostSnapshot.state.players[0]).toMatchObject({
      name: "Alice",
      isYou: false,
    });

    playerWs.close();
    hostWs.close();
  });

  test("duplicate name is rejected", async () => {
    const { roomCode } = await createRoom();
    const { ws: ws1 } = await joinAsPlayer(roomCode, "Bob");

    const ws2 = await openSocket(roomCode);
    send(ws2, { type: "hello", auth: { kind: "join", name: "bob" } });
    const err = (await nextMessage(ws2)) as ErrorMessage;
    expect(err.type).toBe("error");
    expect(err.code).toBe("name_taken");

    ws1.close();
    ws2.close();
  });

  test("join rejected once game has left lobby, but seat-token rejoin is accepted", async () => {
    const { roomCode } = await createRoom();
    const { ws: ws1, welcome } = await joinAsPlayer(roomCode, "Carol");
    const seatToken = welcome.you.seatToken!;
    ws1.close();

    const stub = await stubFor(roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get<{ phase: string }>("room");
      await state.storage.put("room", { ...room, phase: "night" });
    });

    const joinWs = await openSocket(roomCode);
    send(joinWs, { type: "hello", auth: { kind: "join", name: "Dave" } });
    const joinErr = (await nextMessage(joinWs)) as ErrorMessage;
    expect(joinErr.code).toBe("game_in_progress");
    joinWs.close();

    const rejoinWs = await openSocket(roomCode);
    send(rejoinWs, { type: "hello", auth: { kind: "seat", seatToken } });
    const rejoinWelcome = (await nextMessage(rejoinWs)) as WelcomeMessage;
    expect(rejoinWelcome.type).toBe("welcome");
    expect(rejoinWelcome.you.playerId).toBeDefined();
    rejoinWs.close();
  });
});

describe("bad credentials", () => {
  test("bad host key closes with 4003", async () => {
    const { roomCode } = await createRoom();
    const ws = await openSocket(roomCode);
    const closed = nextClose(ws);
    send(ws, { type: "hello", auth: { kind: "host", hostKey: "nope" } });
    const err = (await nextMessage(ws)) as ErrorMessage;
    expect(err.code).toBe("bad_host_key");
    expect((await closed).code).toBe(4003);
  });

  test("bad seat token closes with 4003", async () => {
    const { roomCode } = await createRoom();
    const ws = await openSocket(roomCode);
    const closed = nextClose(ws);
    send(ws, { type: "hello", auth: { kind: "seat", seatToken: "nope" } });
    const err = (await nextMessage(ws)) as ErrorMessage;
    expect(err.code).toBe("bad_seat_token");
    expect((await closed).code).toBe(4003);
  });
});

describe("auth gating", () => {
  test("message before hello is rejected with 4002", async () => {
    const { roomCode } = await createRoom();
    const ws = await openSocket(roomCode);
    const closed = nextClose(ws);
    send(ws, { type: "ping" });
    const err = (await nextMessage(ws)) as ErrorMessage;
    expect(err.code).toBe("not_authenticated");
    expect((await closed).code).toBe(4002);
  });

  test("auth-reap: never hello, alarm closes with 4002 and re-arms", async () => {
    const { roomCode } = await createRoom();
    const stub = await stubFor(roomCode);
    const ws = await openSocket(roomCode);
    const closed = nextClose(ws);

    // Force the pendingAuth entry's connectedAt into the past so the alarm
    // (fired immediately by the test helper) treats it as expired.
    await runInDurableObject(stub, async (_instance, state) => {
      const pending = await state.storage.get<
        { tagId: string; connectedAt: number }[]
      >("pendingAuth");
      expect(pending).toHaveLength(1);
      const rewritten = pending!.map((e) => ({
        ...e,
        connectedAt: Date.now() - 31_000,
      }));
      await state.storage.put("pendingAuth", rewritten);
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    expect((await closed).code).toBe(4002);

    // Alarm re-armed for the next-soonest deadline (empty-lobby / TTL), not
    // one-shot-and-done.
    await runInDurableObject(stub, async (_instance, state) => {
      const alarmTime = await state.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
    });
  });
});

describe("kick", () => {
  test("kick removes seat, closes sockets, and a later hello with that token gets 4003", async () => {
    const { roomCode, hostKey } = await createRoom();
    const hostWs = await openSocket(roomCode);
    send(hostWs, { type: "hello", auth: { kind: "host", hostKey } });
    await nextMessage(hostWs); // welcome

    const { ws: playerWs, welcome } = await joinAsPlayer(roomCode, "Eve");
    await nextMessage(hostWs); // snapshot after join
    const seatToken = welcome.you.seatToken!;
    const playerId = welcome.you.playerId!;

    const playerClosed = nextClose(playerWs);
    const kickedMsg = nextMessageOfType(playerWs, "kicked");
    send(hostWs, { type: "kick", playerId });

    expect((await kickedMsg).type).toBe("kicked");
    expect((await playerClosed).code).toBe(4001);

    const hostSnapshot = await nextMessageOfType(hostWs, "snapshot");
    expect(hostSnapshot.state.players).toHaveLength(0);

    const retryWs = await openSocket(roomCode);
    const retryClosed = nextClose(retryWs);
    send(retryWs, { type: "hello", auth: { kind: "seat", seatToken } });
    const retryErr = await nextMessageOfType(retryWs, "error");
    expect(retryErr.code).toBe("bad_seat_token");
    expect((await retryClosed).code).toBe(4003);

    hostWs.close();
  });
});

describe("presence", () => {
  test("presence flips to false on close and broadcasts", async () => {
    const { roomCode, hostKey } = await createRoom();
    const hostWs = await openSocket(roomCode);
    send(hostWs, { type: "hello", auth: { kind: "host", hostKey } });
    await nextMessage(hostWs);

    const { ws: playerWs } = await joinAsPlayer(roomCode, "Frank");
    await nextMessage(hostWs); // snapshot: Frank connected

    const hostSawDisconnect = nextMessage(hostWs);
    playerWs.close();
    const snapshot = (await hostSawDisconnect) as SnapshotMessage;
    expect(snapshot.state.players[0]).toMatchObject({
      name: "Frank",
      connected: false,
    });

    hostWs.close();
  });

  test("two sockets presenting the same seat token are both live", async () => {
    const { roomCode } = await createRoom();
    const { ws: ws1, welcome } = await joinAsPlayer(roomCode, "Gina");
    const seatToken = welcome.you.seatToken!;

    const ws2 = await openSocket(roomCode);
    send(ws2, { type: "hello", auth: { kind: "seat", seatToken } });
    const welcome2 = (await nextMessage(ws2)) as WelcomeMessage;
    expect(welcome2.you.playerId).toBe(welcome.you.playerId);

    // ws1 gets a broadcast (its own presence unaffected, but confirms both
    // sockets remain attached to the same player without error).
    send(ws1, { type: "ping" });
    const pong = await nextMessageOfType(ws1, "pong");
    expect(pong.type).toBe("pong");

    ws1.close();
    ws2.close();
  });
});

describe("hibernation", () => {
  test("eviction survives — identity intact from attachment afterward", async () => {
    const { roomCode } = await createRoom();
    const { ws, welcome } = await joinAsPlayer(roomCode, "Hank");
    const playerId = welcome.you.playerId;

    const stub = await stubFor(roomCode);
    await evictDurableObject(stub);

    send(ws, { type: "ping" });
    const pong = (await nextMessage(ws)) as PongMessage;
    expect(pong.type).toBe("pong");

    // Confirm identity survived by kicking via a fresh host connection and
    // observing the correct player is removed.
    const stub2 = await stubFor(roomCode);
    const claimed = await runInDurableObject(stub2, async (_i, state) => {
      const room = await state.storage.get<{ hostKey: string }>("room");
      return room!.hostKey;
    });
    const hostWs = await openSocket(roomCode);
    send(hostWs, { type: "hello", auth: { kind: "host", hostKey: claimed } });
    await nextMessage(hostWs);

    const playerClosed = nextClose(ws);
    send(hostWs, { type: "kick", playerId: playerId! });
    await nextMessage(hostWs); // kicked broadcast target isn't host; host gets snapshot next
    expect((await playerClosed).code).toBe(4001);

    hostWs.close();
  });
});

describe("alarm-driven wipes", () => {
  test("empty-lobby wipe fires at +1h when zero players and zero sockets", async () => {
    const { roomCode } = await createRoom();
    const stub = await stubFor(roomCode);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get<{ lastActivityAt: number }>(
        "room",
      );
      await state.storage.put("room", {
        ...room,
        lastActivityAt: Date.now() - (60 * 60 * 1000 + 1000),
      });
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get("room");
      expect(room).toBeUndefined();
    });
  });

  test("no wipe when zero sockets but players are seated (6h TTL path only)", async () => {
    const { roomCode } = await createRoom();
    const { ws } = await joinAsPlayer(roomCode, "Ivy");
    ws.close();

    const stub = await stubFor(roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get<{ lastActivityAt: number }>(
        "room",
      );
      await state.storage.put("room", {
        ...room,
        lastActivityAt: Date.now() - (60 * 60 * 1000 + 1000),
      });
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get("room");
      expect(room).toBeDefined();
    });
  });

  test("no wipe while any socket is connected, even past TTL", async () => {
    const { roomCode } = await createRoom();
    const { ws } = await joinAsPlayer(roomCode, "Jack");

    const stub = await stubFor(roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get<{ lastActivityAt: number }>(
        "room",
      );
      await state.storage.put("room", {
        ...room,
        lastActivityAt: Date.now() - (6 * 60 * 60 * 1000 + 1000),
      });
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get("room");
      expect(room).toBeDefined();
    });

    ws.close();
  });
});

describe("wake-recovery constructor guard", () => {
  test("deleting the alarm out-of-band still lets the empty-lobby wipe fire", async () => {
    // Simulates the crash window Spec 03 v2.2 flags: a deadline input is
    // persisted (lastActivityAt) but nothing is armed. evictDurableObject
    // forces a fresh construction on the next access, which should exercise
    // the constructor guard and re-arm from storage.
    const { roomCode } = await createRoom();
    const stub = await stubFor(roomCode);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get<{ lastActivityAt: number }>(
        "room",
      );
      await state.storage.put("room", {
        ...room,
        lastActivityAt: Date.now() - (60 * 60 * 1000 + 1000),
      });
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });

    await evictDurableObject(stub);

    // Any access reconstructs the DO, running the constructor guard, which
    // should re-arm the alarm from the still-expired lastActivityAt.
    await runInDurableObject(stub, async (_instance, state) => {
      const alarmTime = await state.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get("room");
      expect(room).toBeUndefined();
    });
  });
});
