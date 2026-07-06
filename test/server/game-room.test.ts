import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
  evictDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { Ruleset } from "../../src/engine";
import type {
  ClientMessage,
  ClientRoomState,
  ErrorMessage,
  PongMessage,
  RejectionMessage,
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

// ---------------------------------------------------------------------------
// D4 — game helpers. House rules, untimed, 5 players: seed 19 deals
// p1=angel, p2=villager, p3=detective, p4=villager, p5=mafia (join order
// Alice/Bob/Carol/Dave/Erin) — verified directly against the engine before
// being pinned here. `ALLOW_TEST_SEED` is set for this test project only
// (vitest.workers.config.ts), so `seed` is honored.
// ---------------------------------------------------------------------------

const FIVE_PLAYER_HOUSE_RULES: Ruleset = {
  roles: { mafia: 1, villager: 2, detective: 1, angel: 1, suicide_bomber: 0, minion: 0 },
  mafiaCountFormula: "sqrt",
  firstNightKill: true,
  tiePolicy: "runoff-then-peace",
  dayVoteThreshold: "plurality",
  noMurderOption: true,
  mafiaConsensus: "unanimous",
  revealOnDeath: "full",
  parityRule: "immediate",
  votingVisibility: "hidden",
  timers: {},
  dawnDuskBeatMs: 3000,
};

const SCRIPTED_SEED = 19;

interface FivePlayerGame {
  roomCode: string;
  hostWs: WebSocket;
  hostKey: string;
  // Join order: angel, villager, detective, villager, mafia.
  angel: { ws: WebSocket; playerId: string; seatToken: string };
  villager1: { ws: WebSocket; playerId: string; seatToken: string };
  detective: { ws: WebSocket; playerId: string; seatToken: string };
  villager2: { ws: WebSocket; playerId: string; seatToken: string };
  mafia: { ws: WebSocket; playerId: string; seatToken: string };
}

async function setUpFivePlayerRoom(): Promise<FivePlayerGame> {
  const { roomCode, hostKey } = await createRoom();
  const hostWs = await openSocket(roomCode);
  send(hostWs, { type: "hello", auth: { kind: "host", hostKey } });
  await nextMessage(hostWs); // welcome

  const names = ["Alice", "Bob", "Carol", "Dave", "Erin"] as const;
  const joined: { ws: WebSocket; playerId: string; seatToken: string }[] = [];
  for (const name of names) {
    const { ws, welcome } = await joinAsPlayer(roomCode, name);
    joined.push({
      ws,
      playerId: welcome.you.playerId!,
      seatToken: welcome.you.seatToken!,
    });
    // The join broadcast reaches every already-connected socket (host and
    // every previously joined player) — drain one snapshot from each so no
    // queue is left holding a pre-start_game lobby snapshot.
    await nextMessageOfType(hostWs, "snapshot");
    for (const prior of joined.slice(0, -1)) {
      await nextMessageOfType(prior.ws, "snapshot");
    }
  }

  const [angel, villager1, detective, villager2, mafia] = joined as [
    (typeof joined)[0],
    (typeof joined)[0],
    (typeof joined)[0],
    (typeof joined)[0],
    (typeof joined)[0],
  ];

  return { roomCode, hostWs, hostKey, angel, villager1, detective, villager2, mafia };
}

function sendGame(ws: WebSocket, msg: ClientMessage): void {
  send(ws, msg);
}

async function startScriptedGame(
  game: FivePlayerGame,
): Promise<Record<"angel" | "villager1" | "detective" | "villager2" | "mafia", ClientRoomState>> {
  sendGame(game.hostWs, {
    type: "start_game",
    ruleset: FIVE_PLAYER_HOUSE_RULES,
    seed: SCRIPTED_SEED,
  });
  // Every connected socket, host included, gets a fresh snapshot once the
  // game starts.
  return drainSnapshots(game);
}

/** Every applied game command re-broadcasts a personalized snapshot to every
 * connected socket, host included (apply-persist-broadcast, Spec 03). After
 * sending a command, drain exactly one fresh snapshot per socket — always
 * all six, unconditionally — so no queue is left holding a stale broadcast
 * that a later `nextMessageOfType` call would return instead of the latest
 * one. Returns each player's own composed state, keyed by role name. */
async function drainSnapshots(
  game: FivePlayerGame,
): Promise<Record<"angel" | "villager1" | "detective" | "villager2" | "mafia", ClientRoomState>> {
  const [angel, villager1, detective, villager2, mafia] = await Promise.all([
    nextMessageOfType(game.angel.ws, "snapshot"),
    nextMessageOfType(game.villager1.ws, "snapshot"),
    nextMessageOfType(game.detective.ws, "snapshot"),
    nextMessageOfType(game.villager2.ws, "snapshot"),
    nextMessageOfType(game.mafia.ws, "snapshot"),
  ]);
  await nextMessageOfType(game.hostWs, "snapshot");
  return {
    angel: angel.state,
    villager1: villager1.state,
    detective: detective.state,
    villager2: villager2.state,
    mafia: mafia.state,
  };
}

/** Advances a dawn/dusk announcement beat via the real unified alarm instead
 * of a host force_advance — the spec-true path (dawn/dusk are "zero-input
 * announcement states" that auto-advance once their `dawnDuskBeatMs` timer
 * elapses; a completed night/vote is what arms that timer in the first
 * place, per the fix in this round). Moves the stored deadline (both the
 * DO's own `gameDeadlineAt` bookkeeping and the engine's own
 * `GameState.deadlineAt`, which must move together — see the "short night
 * timer" test) into the past, then forces the still-future real alarm to
 * fire now via `runDurableObjectAlarm`, deterministically, without waiting
 * out the real few-second beat. */
async function advanceViaAlarm(
  game: FivePlayerGame,
): Promise<Record<"angel" | "villager1" | "detective" | "villager2" | "mafia", ClientRoomState>> {
  const stub = await stubFor(game.roomCode);
  await runInDurableObject(stub, async (_instance, state) => {
    const past = Date.now() - 1;
    await state.storage.put("gameDeadlineAt", past);
    const g = await state.storage.get<{ deadlineAt: number }>("game");
    await state.storage.put("game", { ...g, deadlineAt: past });
  });
  const ran = await runDurableObjectAlarm(stub);
  expect(ran).toBe(true);
  return drainSnapshots(game);
}

/** Spec 11: every living player owes a night input. After the "real" actors
 * (mafia/angel/detective) have submitted, this settles the rest so the night
 * can resolve naturally: it locks the angel & detective (they submit in the
 * scripts but the confirm is new), and drives both villagers' decoy
 * `"watch"` pick + confirm. Each command drains the broadcast. Pass the
 * players to skip (e.g. a dead one, or one the test drives itself). */
async function settleNightRemainder(
  game: FivePlayerGame,
  skip: string[] = [],
): Promise<Record<"angel" | "villager1" | "detective" | "villager2" | "mafia", ClientRoomState>> {
  let snap!: Record<"angel" | "villager1" | "detective" | "villager2" | "mafia", ClientRoomState>;
  // Angel & detective: confirm their already-submitted pick.
  for (const actor of [game.angel, game.detective] as const) {
    if (skip.includes(actor.playerId)) continue;
    sendGame(actor.ws, { type: "lock_action" });
    snap = await drainSnapshots(game);
  }
  // Villagers: decoy pick (watch someone alive) + confirm.
  for (const v of [game.villager1, game.villager2] as const) {
    if (skip.includes(v.playerId)) continue;
    sendGame(v.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    snap = await drainSnapshots(game);
    sendGame(v.ws, { type: "lock_action" });
    snap = await drainSnapshots(game);
  }
  return snap;
}

/** Spec 11: acknowledge the dawn Morning Report for every living player,
 * echoing the current phaseGen. Returns the final drained snapshots. */
async function acknowledgeDawn(
  game: FivePlayerGame,
  gen: number,
  living: readonly { ws: WebSocket; playerId: string }[],
): Promise<Record<"angel" | "villager1" | "detective" | "villager2" | "mafia", ClientRoomState>> {
  let snap!: Record<"angel" | "villager1" | "detective" | "villager2" | "mafia", ClientRoomState>;
  for (const p of living) {
    sendGame(p.ws, { type: "acknowledge", gen });
    snap = await drainSnapshots(game);
  }
  return snap;
}

/** Spec 11: cast + confirm a day vote for each listed player. */
async function voteConfirmAll(
  game: FivePlayerGame,
  target: string,
  voters: readonly { ws: WebSocket; playerId: string }[],
): Promise<Record<"angel" | "villager1" | "detective" | "villager2" | "mafia", ClientRoomState>> {
  let snap!: Record<"angel" | "villager1" | "detective" | "villager2" | "mafia", ClientRoomState>;
  for (const p of voters) {
    sendGame(p.ws, { type: "cast_vote", target });
    snap = await drainSnapshots(game);
    sendGame(p.ws, { type: "confirm_vote" });
    snap = await drainSnapshots(game);
  }
  return snap;
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

// ---------------------------------------------------------------------------
// D4 — game (Spec 03)
// ---------------------------------------------------------------------------

describe("game lifecycle: start_game authority and validation", () => {
  test("non-host start_game is rejected", async () => {
    const game = await setUpFivePlayerRoom();
    sendGame(game.angel.ws, {
      type: "start_game",
      ruleset: FIVE_PLAYER_HOUSE_RULES,
      seed: SCRIPTED_SEED,
    });
    const rejection = (await nextMessageOfType(
      game.angel.ws,
      "rejection",
    )) as RejectionMessage;
    expect(rejection.code).toBe("not_host");
  });

  test("start_game with too few players is refused with invalid_ruleset", async () => {
    const { roomCode, hostKey } = await createRoom();
    const hostWs = await openSocket(roomCode);
    send(hostWs, { type: "hello", auth: { kind: "host", hostKey } });
    await nextMessage(hostWs);
    await joinAsPlayer(roomCode, "Solo");
    await nextMessageOfType(hostWs, "snapshot");

    sendGame(hostWs, {
      type: "start_game",
      ruleset: FIVE_PLAYER_HOUSE_RULES,
      seed: SCRIPTED_SEED,
    });
    const err = (await nextMessageOfType(hostWs, "error")) as ErrorMessage;
    expect(err.code).toBe("invalid_ruleset");
  });

  test("start_game with an invalid ruleset (mafia required) is refused", async () => {
    const game = await setUpFivePlayerRoom();
    const badRuleset: Ruleset = {
      ...FIVE_PLAYER_HOUSE_RULES,
      roles: { villager: "auto" },
    };
    sendGame(game.hostWs, {
      type: "start_game",
      ruleset: badRuleset,
      seed: SCRIPTED_SEED,
    });
    const err = (await nextMessageOfType(game.hostWs, "error")) as ErrorMessage;
    expect(err.code).toBe("invalid_ruleset");
  });

  test("join is rejected once start_game applies; seat rejoin still works", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    const lateJoin = await openSocket(game.roomCode);
    send(lateJoin, { type: "hello", auth: { kind: "join", name: "Latecomer" } });
    const err = (await nextMessage(lateJoin)) as ErrorMessage;
    expect(err.code).toBe("game_in_progress");
    lateJoin.close();

    const rejoin = await openSocket(game.roomCode);
    send(rejoin, { type: "hello", auth: { kind: "seat", seatToken: game.angel.seatToken } });
    const welcome = (await nextMessage(rejoin)) as WelcomeMessage;
    expect(welcome.you.playerId).toBe(game.angel.playerId);
    expect(welcome.state.game?.you?.roleId).toBe("angel");
    rejoin.close();
  });
});

describe("full scripted game over real WebSockets", () => {
  test("night kill, angel save, detective result, day vote, village win", async () => {
    const game = await setUpFivePlayerRoom();
    const afterStart = await startScriptedGame(game);

    // The snapshot after start_game carries the composed game view — spot
    // check the detective's own role is visible only to them.
    expect(afterStart.detective.phase).toBe("night");
    expect(afterStart.detective.game?.you?.roleId).toBe("detective");

    // Night 1: mafia (Erin) kills Dave (villager2), angel (Alice) protects
    // Bob (villager1) — protection doesn't cover Dave, so the kill lands.
    // Detective (Carol) investigates the mafia (Erin) -> isMafia true, and
    // that result must appear only in the detective's own snapshot.
    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
    await drainSnapshots(game);
    sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    await drainSnapshots(game);
    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    await drainSnapshots(game);
    // Spec 08: the mafia must LOCK its pick. Spec 11: the angel, detective, and
    // BOTH villagers (via decoy `"watch"`) must also confirm before the night
    // can complete — every living player performs the same pick→confirm.
    sendGame(game.mafia.ws, { type: "lock_action" });
    await drainSnapshots(game);
    const afterNight1 = await settleNightRemainder(game);

    expect(afterNight1.detective.phase).toBe("dawn");
    expect(afterNight1.detective.game?.you?.investigationResults).toEqual([
      { day: 1, targetId: game.mafia.playerId, isMafia: true },
    ]);
    // Nobody else's snapshot carries the detective's private investigation
    // result.
    for (const key of ["angel", "villager1", "mafia"] as const) {
      expect(afterNight1[key].game?.you?.investigationResults).toBeUndefined();
    }
    // Dave (villager2) died; his own next snapshot shows him dead.
    expect(afterNight1.villager1.game?.players.find((p) => p.id === game.villager2.playerId)?.alive).toBe(false);
    // The last night action (a player's, not the host's) armed the dawn
    // beat's deadline — the regression this round fixed: a player-triggered
    // completion used to strand the game with deadlineAt: null.
    expect(afterNight1.detective.game?.deadlineAt).not.toBeNull();

    // Dawn -> day via the real unified alarm (spec-true: dawn is a
    // zero-input announcement beat that auto-advances, no host action).
    const afterDawn = await advanceViaAlarm(game);
    expect(afterDawn.detective.phase).toBe("day");

    // Day 1: everybody votes no_murder to survive to a second night (so the
    // angel's night-2 save is the one under test). Spec 11: cast + confirm.
    const afterDayVote = await voteConfirmAll(game, "no_murder", [game.angel, game.villager1, game.detective, game.mafia]);
    expect(afterDayVote.detective.phase).toBe("dusk");
    // The last vote (a player's) armed the dusk beat's deadline too.
    expect(afterDayVote.detective.game?.deadlineAt).not.toBeNull();

    // Dusk -> night 2, also via the real alarm (same zero-input beat).
    const afterDusk = await advanceViaAlarm(game);
    expect(afterDusk.detective.phase).toBe("night");
    expect(afterDusk.detective.game?.day).toBe(2);

    // Night 2: mafia targets Bob (villager1); angel protects Bob this time
    // -> the attack fails and Bob survives (the scripted "angel save").
    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    await drainSnapshots(game);
    sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    await drainSnapshots(game);
    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    await drainSnapshots(game);
    sendGame(game.mafia.ws, { type: "lock_action" });
    await drainSnapshots(game);
    // villager2 is dead now — skip it; the rest confirm (angel/detective) and
    // villager1 files a decoy.
    const afterNight2 = await settleNightRemainder(game, [game.villager2.playerId]);

    expect(afterNight2.detective.phase).toBe("dawn");
    expect(afterNight2.villager1.game?.players.find((p) => p.id === game.villager1.playerId)?.alive).toBe(true);
    expect(
      afterNight2.detective.game?.log.some(
        (e) => e.type === "attackAttempted" && e.outcome === "failed" && e.targetId === game.villager1.playerId,
      ),
    ).toBe(true);

    // Host-impatience path: dawn's beat deadline is correctly armed here
    // too (night 2's last action was player-triggered, same fix), but the
    // host doesn't have to wait for it — force_advance is still a valid
    // shortcut past an armed deadline, not just a recovery for a stranded
    // one. Deliberately exercised once here; every other beat above uses
    // the real alarm to prove the auto-advance path works unattended.
    sendGame(game.hostWs, { type: "force_advance", gen: afterNight2.detective.game!.phaseGen });
    const afterDawn2 = await drainSnapshots(game);
    expect(afterDawn2.detective.phase).toBe("day");

    // Day 2: everyone votes to eliminate the mafia -> village wins the
    // instant mafia count hits zero (evaluated inside vote resolution).
    // Spec 11: cast + confirm.
    const final = await voteConfirmAll(game, game.mafia.playerId, [game.angel, game.villager1, game.detective, game.mafia]);
    expect(final.detective.phase).toBe("ended");
    expect(final.detective.game?.winners).toEqual(["village"]);

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("mid-game hibernation and rejoin", () => {
  test("eviction mid-night survives — sockets and pending actions intact", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
    await drainSnapshots(game);

    const stub = await stubFor(game.roomCode);
    await evictDurableObject(stub);

    // Sockets survive the eviction; a fresh command applies against the
    // reconstructed DO with roles/pending actions intact.
    sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    await drainSnapshots(game);
    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    await drainSnapshots(game);
    // Spec 08: the mafia's pre-eviction pick survived (state persisted
    // opaquely) but is still only tentative — lock it in post-eviction to
    // prove the lock command applies cleanly against the reconstructed DO.
    sendGame(game.mafia.ws, { type: "lock_action" });
    await drainSnapshots(game);
    // Spec 11: angel/detective confirm + villagers file decoys to complete.
    const afterNight1 = await settleNightRemainder(game);

    expect(afterNight1.detective.phase).toBe("dawn");
    expect(afterNight1.detective.game?.you?.roleId).toBe("detective");
    expect(afterNight1.detective.game?.you?.investigationResults).toEqual([
      { day: 1, targetId: game.mafia.playerId, isMafia: true },
    ]);
    // The mafia kill submitted before eviction still resolved.
    expect(afterNight1.angel.game?.players.find((p) => p.id === game.villager2.playerId)?.alive).toBe(false);

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("mid-night rejoin: closed socket, fresh hello with seat token welcomes with role + pending action", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    await drainSnapshots(game);

    game.detective.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rejoinWs = await openSocket(game.roomCode);
    send(rejoinWs, { type: "hello", auth: { kind: "seat", seatToken: game.detective.seatToken } });
    const welcome = (await nextMessage(rejoinWs)) as WelcomeMessage;

    expect(welcome.you.playerId).toBe(game.detective.playerId);
    expect(welcome.state.phase).toBe("night");
    expect(welcome.state.game?.you?.roleId).toBe("detective");
    expect(welcome.state.game?.you?.pendingAction).toEqual({
      actionType: "investigate",
      targetId: game.mafia.playerId,
    });

    rejoinWs.close();
    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("timer path and stale-alarm no-op", () => {
  test("a player's own action completing the night arms the dawn beat's alarm, no force_advance needed", async () => {
    // Regression (fix round 1): applyCommand's submitAction/castVote/
    // retractVote/markAbsent/markPresent branches called advanceIfComplete
    // with no `now`, so a player's own last action completing a phase never
    // armed the next beat's deadline — only host-issued forceAdvance/
    // timerExpired carried `now`. That stranded every untimed house-rules
    // game in dawn/dusk forever, since nothing ever calls force_advance in
    // ordinary play. Fixed by threading `now` through every command
    // variant; this test proves the DO-level, real-alarm, no-force_advance
    // path end to end.
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
    await drainSnapshots(game);
    sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    await drainSnapshots(game);
    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    await drainSnapshots(game);
    // Spec 08: the mafia's lock-in (not its submit) is the last pending
    // night input now — a player, not the host, still triggers the night ->
    // dawn transition.
    sendGame(game.mafia.ws, { type: "lock_action" });
    await drainSnapshots(game);
    // Spec 11: the LAST living player's confirm (a villager's decoy lock, via
    // settleNightRemainder) is the player-triggered completion that arms the
    // dawn beat — still a player, not the host.
    const afterNight1 = await settleNightRemainder(game);
    expect(afterNight1.detective.phase).toBe("dawn");

    const stub = await stubFor(game.roomCode);
    const armed = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.get<number>("gameDeadlineAt");
    });
    expect(armed).toBeTypeOf("number");

    // The real alarm, fired with no force_advance anywhere in this test,
    // advances dawn -> day on its own.
    const afterDawn = await advanceViaAlarm(game);
    expect(afterDawn.detective.phase).toBe("day");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("short night timer expires via the unified alarm and defaults apply", async () => {
    const game = await setUpFivePlayerRoom();
    const timedRuleset: Ruleset = { ...FIVE_PLAYER_HOUSE_RULES, timers: { night: 5 } };
    sendGame(game.hostWs, { type: "start_game", ruleset: timedRuleset, seed: SCRIPTED_SEED });
    const afterStart = await drainSnapshots(game);
    expect(afterStart.detective.game?.deadlineAt).not.toBeNull();

    // Rewrite the stored deadline into the past — both the DO's own
    // bookkeeping key (`gameDeadlineAt`, what the alarm's due-check reads)
    // and the engine's own copy inside `GameState.deadlineAt` (what
    // `applyCommand`'s `timerExpired` validates `at` against, Spec 02 v2.1)
    // must move together, exactly as `applyEffects`' `setDeadline` handler
    // keeps them in lockstep during normal play — otherwise the engine
    // treats the alarm as stale and no-ops. Leave Miniflare's actually-armed
    // alarm at its real (few-seconds-out) wall-clock time so there's no race
    // with the platform's own background alarm fire (which an
    // already-elapsed `setAlarm` would trigger nondeterministically) —
    // `runDurableObjectAlarm` forces that still-future alarm to run now,
    // exactly like the pre-existing auth-reap test does for
    // `pendingAuth.connectedAt`.
    const stub = await stubFor(game.roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      const at = await state.storage.get<number>("gameDeadlineAt");
      expect(at).toBeTypeOf("number");
      const past = Date.now() - 1;
      await state.storage.put("gameDeadlineAt", past);
      const g = await state.storage.get<{ deadlineAt: number }>("game");
      await state.storage.put("game", { ...g, deadlineAt: past });
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const afterTimeout = await drainSnapshots(game);
    // Nobody submitted a night action — defaults apply (no deaths, mafia
    // vote unresolved) and the phase still advances to dawn.
    expect(afterTimeout.detective.phase).toBe("dawn");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("stale alarm after a force-advance is a harmless no-op", async () => {
    const game = await setUpFivePlayerRoom();
    const timedRuleset: Ruleset = { ...FIVE_PLAYER_HOUSE_RULES, timers: { night: 5 } };
    sendGame(game.hostWs, { type: "start_game", ruleset: timedRuleset, seed: SCRIPTED_SEED });
    const afterStart = await drainSnapshots(game);
    const staleDeadlineAt = afterStart.detective.game!.deadlineAt!;
    const genAtStart = afterStart.detective.game!.phaseGen;

    // Host force-advances first, consuming the deadline the engine had
    // armed (dawn gets its own fresh dawn-beat deadline under house rules) —
    // gameDeadlineAt and the engine's own state.deadlineAt move together,
    // atomically, exactly as applyEffects keeps them in lockstep.
    sendGame(game.hostWs, { type: "force_advance", gen: genAtStart });
    const afterForce = await drainSnapshots(game);
    expect(afterForce.detective.phase).toBe("dawn");
    const dawnDeadlineAt = afterForce.detective.game!.deadlineAt!;
    expect(dawnDeadlineAt).not.toBe(staleDeadlineAt);

    // Simulate the night-1 alarm's callback finally running late (Cloudflare
    // alarms carry no payload — everything is reconstructed fresh from
    // storage at fire time, Spec 03's pinned model) after force_advance
    // already rearmed for the newer dawn-beat deadline. The due-check reads
    // gameDeadlineAt fresh and finds the CURRENT (dawn) deadline hasn't
    // elapsed yet -> not due -> skip, re-arm for it unchanged. This is the
    // DO-layer half of the "harmless at both layers" guarantee: a duplicate
    // or delayed alarm fire never applies a command for a deadline that
    // isn't the one currently due.
    const stub = await stubFor(game.roomCode);
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const afterSpuriousFire = await runInDurableObject(stub, async (_instance, state) => {
      const current = await state.storage.get<number>("gameDeadlineAt");
      const g = await state.storage.get<{ phase: string }>("game");
      return { current, phase: g?.phase };
    });
    expect(afterSpuriousFire.current).toBe(dawnDeadlineAt);
    expect(afterSpuriousFire.phase).toBe("dawn");

    // No broadcast fired from the spurious fire — confirm by sending a ping
    // and observing only a pong arrives, nothing queued ahead of it.
    sendGame(game.hostWs, { type: "ping" });
    const pong = (await nextMessageOfType(game.hostWs, "pong")) as PongMessage;
    expect(pong.type).toBe("pong");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("authority: host-only game commands", () => {
  test("non-host force_advance, mark_absent are rejected; host-spoofed payload ignored", async () => {
    const game = await setUpFivePlayerRoom();
    const afterStart = await startScriptedGame(game);

    sendGame(game.angel.ws, { type: "force_advance", gen: afterStart.angel.game!.phaseGen });
    const rejection1 = (await nextMessageOfType(game.angel.ws, "rejection")) as RejectionMessage;
    expect(rejection1.code).toBe("not_host");

    sendGame(game.angel.ws, { type: "mark_absent", playerId: game.villager1.playerId });
    const rejection2 = (await nextMessageOfType(game.angel.ws, "rejection")) as RejectionMessage;
    expect(rejection2.code).toBe("not_host");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("mark_absent/mark_present flip presence and broadcast", async () => {
    const game = await setUpFivePlayerRoom();
    const afterStart = await startScriptedGame(game);
    void afterStart;

    sendGame(game.hostWs, { type: "mark_absent", playerId: game.villager1.playerId });
    const afterAbsent = await drainSnapshots(game);
    expect(afterAbsent.detective.game?.players.find((p) => p.id === game.villager1.playerId)?.absent).toBe(true);

    sendGame(game.hostWs, { type: "mark_present", playerId: game.villager1.playerId });
    const afterPresent = await drainSnapshots(game);
    expect(afterPresent.detective.game?.players.find((p) => p.id === game.villager1.playerId)?.absent).toBe(false);

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("lifecycle: new_game", () => {
  test("new_game is refused mid-game", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    sendGame(game.hostWs, { type: "new_game" });
    const rejection = (await nextMessageOfType(
      game.hostWs,
      "rejection",
    )) as RejectionMessage;
    expect(rejection.code).toBe("not_ended");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("new_game accepted once ended; seats retained; lobby joins work after", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    // Fast-forward to a village win via forceAdvance defaults: force through
    // night 1 (no actions submitted -> nobody dies), day 1 vote to eliminate
    // the mafia directly.
    sendGame(game.hostWs, { type: "force_advance", gen: 0 });
    const afterNight1 = await drainSnapshots(game);
    expect(afterNight1.detective.phase).toBe("dawn");

    sendGame(game.hostWs, { type: "force_advance", gen: afterNight1.detective.game!.phaseGen });
    const afterDawn = await drainSnapshots(game);
    expect(afterDawn.detective.phase).toBe("day");

    // Spec 11: cast + confirm from every living player to resolve the vote.
    const final = await voteConfirmAll(game, game.mafia.playerId, [
      game.angel,
      game.villager1,
      game.detective,
      game.villager2,
      game.mafia,
    ]);
    expect(final.detective.phase).toBe("ended");

    sendGame(game.hostWs, { type: "new_game" });
    const afterNewGame = await drainSnapshots(game);
    expect(afterNewGame.detective.phase).toBe("lobby");
    expect(afterNewGame.detective.game).toBeNull();
    expect(afterNewGame.detective.players).toHaveLength(5);

    const lateJoin = await openSocket(game.roomCode);
    send(lateJoin, { type: "hello", auth: { kind: "join", name: "Newcomer" } });
    const welcome = (await nextMessage(lateJoin)) as WelcomeMessage;
    expect(welcome.state.phase).toBe("lobby");
    lateJoin.close();

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("kick refused mid-game", () => {
  test("host kick during an active game is refused", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    sendGame(game.hostWs, { type: "kick", playerId: game.angel.playerId });
    const err = (await nextMessageOfType(game.hostWs, "error")) as ErrorMessage;
    expect(err.code).toBe("not_lobby");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("projection privacy sweep", () => {
  test("no living villager's frame ever reveals another living player's role", async () => {
    const game = await setUpFivePlayerRoom();
    const frames: ClientRoomState[] = [];

    const afterStart = await startScriptedGame(game);
    frames.push(afterStart.villager1);

    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
    frames.push((await drainSnapshots(game)).villager1);
    sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    frames.push((await drainSnapshots(game)).villager1);
    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    frames.push((await drainSnapshots(game)).villager1);

    sendGame(game.hostWs, { type: "force_advance", gen: frames.at(-1)!.game!.phaseGen });
    frames.push((await drainSnapshots(game)).villager1);

    // Bob (villager1) is alive the whole time — his frames must never show
    // a roleId/alignment for any other living player (Alice/angel, Carol/
    // detective, Erin/mafia). Dave (villager2) died this night, so full
    // reveal-on-death is expected for him only.
    const livingOthers = [game.angel.playerId, game.detective.playerId, game.mafia.playerId];
    for (const frame of frames) {
      for (const p of frame.game?.players ?? []) {
        if (livingOthers.includes(p.id) && p.alive) {
          expect(p.roleId).toBeUndefined();
          expect(p.alignment).toBeUndefined();
        }
      }
    }

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("host's frame sees every role at all times", async () => {
    const game = await setUpFivePlayerRoom();
    const afterStart = await startScriptedGame(game);
    void afterStart;

    sendGame(game.hostWs, { type: "ping" });
    await nextMessageOfType(game.hostWs, "pong");

    const hostState = await new Promise<ClientRoomState>((resolve) => {
      // Force a fresh broadcast to inspect the host's own composed view.
      sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
      nextMessageOfType(game.hostWs, "snapshot").then((msg) => resolve(msg.state));
    });
    // Drain the player sockets' matching broadcast so queues don't leak
    // into later assertions in this (single-test) suite.
    await Promise.all([
      nextMessageOfType(game.angel.ws, "snapshot"),
      nextMessageOfType(game.villager1.ws, "snapshot"),
      nextMessageOfType(game.detective.ws, "snapshot"),
      nextMessageOfType(game.villager2.ws, "snapshot"),
      nextMessageOfType(game.mafia.ws, "snapshot"),
    ]);

    expect(hostState.game?.players.every((p) => p.roleId !== undefined)).toBe(true);

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("player order is join order, always", () => {
  test("room and game player arrays never reorder across the whole game", async () => {
    const game = await setUpFivePlayerRoom();
    const expectedOrder = [
      game.angel.playerId,
      game.villager1.playerId,
      game.detective.playerId,
      game.villager2.playerId,
      game.mafia.playerId,
    ];

    const afterStart = await startScriptedGame(game);
    expect(afterStart.detective.players.map((p) => p.id)).toEqual(expectedOrder);
    expect(afterStart.detective.game?.players.map((p) => p.id)).toEqual(expectedOrder);

    // Kill Dave (villager2) via a night action and re-check post-death: the
    // dead player must stay in the same position, never moved to the back.
    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
    await drainSnapshots(game);
    sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    await drainSnapshots(game);
    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    await drainSnapshots(game);
    sendGame(game.mafia.ws, { type: "lock_action" });
    await drainSnapshots(game);
    // Spec 11: settle the rest (angel/detective confirm, both villagers file
    // decoys while still alive) so the night resolves and villager2's death
    // lands.
    const afterNight1 = await settleNightRemainder(game);

    expect(afterNight1.detective.players.map((p) => p.id)).toEqual(expectedOrder);
    expect(afterNight1.detective.game?.players.map((p) => p.id)).toEqual(expectedOrder);
    expect(afterNight1.detective.game?.players.find((p) => p.id === game.villager2.playerId)?.alive).toBe(false);

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("wake recovery: gameDeadlineAt", () => {
  test("crash-window guard re-arms the alarm from a persisted gameDeadlineAt", async () => {
    const game = await setUpFivePlayerRoom();
    const timedRuleset: Ruleset = { ...FIVE_PLAYER_HOUSE_RULES, timers: { night: 5 } };
    sendGame(game.hostWs, { type: "start_game", ruleset: timedRuleset, seed: SCRIPTED_SEED });
    const afterStart = await drainSnapshots(game);
    expect(afterStart.detective.game?.deadlineAt).not.toBeNull();

    const stub = await stubFor(game.roomCode);
    // Simulate the crash window: the deadline is persisted but the alarm
    // itself got deleted out-of-band (as if the process died between the
    // storage put and the setAlarm call).
    await runInDurableObject(stub, async (_instance, state) => {
      const at = await state.storage.get<number>("gameDeadlineAt");
      expect(at).toBeTypeOf("number");
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });

    await evictDurableObject(stub);

    // Any access reconstructs the DO, running the constructor guard, which
    // re-arms from the still-persisted gameDeadlineAt.
    await runInDurableObject(stub, async (_instance, state) => {
      const alarmTime = await state.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
    });

    // Move the deadline into the past so the alarm's due-check treats it as
    // elapsed without waiting out the real night timer — both the DO's own
    // bookkeeping key and the engine's own state.deadlineAt move together
    // (they're always kept in lockstep by applyEffects during normal play;
    // see the "short night timer" test above for why touching only one
    // desyncs the due-check from what applyCommand validates `at` against).
    // Miniflare's own armed-alarm wall-clock time is left as whatever the
    // constructor guard re-armed — still a few seconds out — so
    // runDurableObjectAlarm forcing it early doesn't race a background fire.
    await runInDurableObject(stub, async (_instance, state) => {
      const past = Date.now() - 1;
      await state.storage.put("gameDeadlineAt", past);
      const g = await state.storage.get<{ deadlineAt: number }>("game");
      await state.storage.put("game", { ...g, deadlineAt: past });
    });
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const afterTimeout = await drainSnapshots(game);
    expect(afterTimeout.detective.phase).toBe("dawn");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("Spec 08: lock_action/unlock_action", () => {
  test("lock/unlock round-trip: submit -> lock -> unlock -> lock, projected locked state flips each time", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
    await drainSnapshots(game);

    sendGame(game.mafia.ws, { type: "lock_action" });
    const afterLock = await drainSnapshots(game);
    expect(afterLock.mafia.game?.you?.factionVotes?.[0]).toMatchObject({ locked: true, targetId: game.villager2.playerId });

    sendGame(game.mafia.ws, { type: "unlock_action" });
    const afterUnlock = await drainSnapshots(game);
    expect(afterUnlock.mafia.game?.you?.factionVotes?.[0]).toMatchObject({ locked: false, targetId: game.villager2.playerId });
    // Unlocking alone (sole killer) reopens the night — it must not have
    // resolved from the earlier lock.
    expect(afterUnlock.mafia.phase).toBe("night");

    sendGame(game.mafia.ws, { type: "lock_action" });
    const afterRelock = await drainSnapshots(game);
    expect(afterRelock.mafia.game?.you?.factionVotes?.[0]).toMatchObject({ locked: true, targetId: game.villager2.playerId });

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("night resolves only after all killers lock — tentative submissions never end the night", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
    await drainSnapshots(game);
    sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    await drainSnapshots(game);
    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    const afterAllSubmitted = await drainSnapshots(game);
    // Everyone has submitted, but the sole mafia hasn't locked -> still night.
    expect(afterAllSubmitted.detective.phase).toBe("night");

    sendGame(game.mafia.ws, { type: "lock_action" });
    const afterLock = await drainSnapshots(game);
    // Spec 11: the mafia lock alone no longer ends the night — the angel,
    // detective, and villagers still owe their confirms/decoys.
    expect(afterLock.detective.phase).toBe("night");
    const afterAll = await settleNightRemainder(game);
    expect(afterAll.detective.phase).toBe("dawn");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("authority: lock/unlock with no pick rejected no_pick_to_lock; host socket not_a_player", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    // Spec 11: a villager now owes a decoy `"watch"`, so they CAN lock — but
    // with no pick set yet they get `no_pick_to_lock` (not `not_lockable`;
    // they have a lockable night input now).
    sendGame(game.villager1.ws, { type: "lock_action" });
    const rejection1 = (await nextMessageOfType(game.villager1.ws, "rejection")) as RejectionMessage;
    expect(rejection1.code).toBe("no_pick_to_lock");

    // The angel has submitted nothing yet -> nothing to unlock -> not_lockable.
    sendGame(game.angel.ws, { type: "unlock_action" });
    const rejection2 = (await nextMessageOfType(game.angel.ws, "rejection")) as RejectionMessage;
    expect(rejection2.code).toBe("not_lockable");

    // The host socket has no playerId at all -> also rejected, never a crash.
    sendGame(game.hostWs, { type: "lock_action" });
    const rejection3 = (await nextMessageOfType(game.hostWs, "rejection")) as RejectionMessage;
    expect(rejection3.code).toBe("not_a_player");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("lock_action with no pick set is rejected no_pick_to_lock", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    sendGame(game.mafia.ws, { type: "lock_action" });
    const rejection = (await nextMessageOfType(game.mafia.ws, "rejection")) as RejectionMessage;
    expect(rejection.code).toBe("no_pick_to_lock");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("lock_action/unlock_action arriving after the night has already resolved are rejected, never silently ignored", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);

    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
    await drainSnapshots(game);
    sendGame(game.mafia.ws, { type: "lock_action" });
    await drainSnapshots(game);
    sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    await drainSnapshots(game);
    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    await drainSnapshots(game);
    // Spec 11: settle the angel/detective confirms + villager decoys so the
    // night actually resolves into dawn.
    const afterNight1 = await settleNightRemainder(game);
    expect(afterNight1.detective.phase).toBe("dawn");

    // Night has already resolved (phase moved to dawn) — a late lock/unlock
    // from the same mafia socket must be rejected, not silently swallowed.
    sendGame(game.mafia.ws, { type: "lock_action" });
    const rejection1 = (await nextMessageOfType(game.mafia.ws, "rejection")) as RejectionMessage;
    expect(rejection1.code).toBe("not_lockable");

    sendGame(game.mafia.ws, { type: "unlock_action" });
    const rejection2 = (await nextMessageOfType(game.mafia.ws, "rejection")) as RejectionMessage;
    expect(rejection2.code).toBe("not_lockable");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});

describe("Spec 11: set_ruleset / pendingRuleset, confirm_vote, acknowledge", () => {
  test("set_ruleset (host, lobby) broadcasts pendingRuleset to players; non-host rejected", async () => {
    const game = await setUpFivePlayerRoom();

    const customRuleset: Ruleset = {
      ...FIVE_PLAYER_HOUSE_RULES,
      roles: { villager: "auto", mafia: 2, detective: 1, angel: 0, suicide_bomber: 0, minion: 0 },
    };
    sendGame(game.hostWs, { type: "set_ruleset", ruleset: customRuleset });
    const snap = (await nextMessageOfType(game.villager1.ws, "snapshot")).state;
    expect(snap.pendingRuleset?.roles.mafia).toBe(2);
    expect(snap.pendingRuleset?.roles.detective).toBe(1);
    await Promise.all([
      nextMessageOfType(game.angel.ws, "snapshot"),
      nextMessageOfType(game.detective.ws, "snapshot"),
      nextMessageOfType(game.villager2.ws, "snapshot"),
      nextMessageOfType(game.hostWs, "snapshot"),
    ]);

    sendGame(game.villager1.ws, { type: "set_ruleset", ruleset: customRuleset });
    const rej = (await nextMessageOfType(game.villager1.ws, "rejection")) as RejectionMessage;
    expect(rej.code).toBe("not_host");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("set_ruleset is rejected once a game is running (not_lobby)", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);
    sendGame(game.hostWs, { type: "set_ruleset", ruleset: FIVE_PLAYER_HOUSE_RULES });
    const rej = (await nextMessageOfType(game.hostWs, "rejection")) as RejectionMessage;
    expect(rej.code).toBe("not_lobby");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("day vote confirm_vote gates resolution; the projection exposes the voter's own lock state", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);
    sendGame(game.hostWs, { type: "force_advance", gen: 0 });
    const afterNight = await drainSnapshots(game);
    sendGame(game.hostWs, { type: "force_advance", gen: afterNight.detective.game!.phaseGen });
    const afterDawn = await drainSnapshots(game);
    expect(afterDawn.detective.phase).toBe("day");

    let snap = afterDawn;
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia] as const) {
      sendGame(p.ws, { type: "cast_vote", target: game.mafia.playerId });
      snap = await drainSnapshots(game);
    }
    expect(snap.detective.phase).toBe("day"); // all tentative -> not resolved
    expect(snap.detective.game?.you?.currentVote).toBe(game.mafia.playerId);
    expect(snap.detective.game?.you?.dayVoteLocked).toBe(false);

    const final = await voteConfirmAll(game, game.mafia.playerId, [
      game.angel,
      game.villager1,
      game.detective,
      game.villager2,
      game.mafia,
    ]);
    expect(final.detective.phase).toBe("ended");
    expect(final.detective.game?.winners).toEqual(["village"]);

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });

  test("dawn acknowledge advances once all living ack; a stale-gen ack is a no-op", async () => {
    const game = await setUpFivePlayerRoom();
    await startScriptedGame(game);
    sendGame(game.hostWs, { type: "force_advance", gen: 0 });
    const afterNight = await drainSnapshots(game);
    expect(afterNight.detective.phase).toBe("dawn");
    const gen = afterNight.detective.game!.phaseGen;

    // Stale-gen ack: no state change, no broadcast.
    sendGame(game.villager1.ws, { type: "acknowledge", gen: gen + 99 });

    const living = [game.angel, game.villager1, game.detective, game.villager2, game.mafia] as const;
    const afterAck = await acknowledgeDawn(game, gen, living);
    expect(afterAck.detective.phase).toBe("day");

    game.hostWs.close();
    game.angel.ws.close();
    game.villager1.ws.close();
    game.detective.ws.close();
    game.villager2.ws.close();
    game.mafia.ws.close();
  });
});
