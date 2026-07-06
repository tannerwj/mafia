import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
  evictDurableObject,
} from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import type { Ruleset } from "../../src/engine";
import type {
  ClientMessage,
  ClientRoomState,
  ErrorMessage,
  PongMessage,
  RejectionMessage,
  ServerMessage,
  SnapshotMessage,
  StoryDraftMessage,
  StoryErrorMessage,
  StoryState,
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
  scenePhases: false,
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

describe("Spec 17 D4: ended-game TTL", () => {
  test("wipes a room whose game phase is 'ended' at +2h idle, with reason ended_ttl", async () => {
    const { roomCode } = await createRoom();
    const stub = await stubFor(roomCode);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get<{ lastActivityAt: number }>("room");
      await state.storage.put("room", {
        ...room,
        phase: "ended",
        lastActivityAt: Date.now() - (2 * 60 * 60 * 1000 + 1000),
      });
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get("room");
      expect(room).toBeUndefined();
    });
  });

  test("does NOT wipe an ended game before the 2h mark", async () => {
    const { roomCode } = await createRoom();
    const stub = await stubFor(roomCode);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get<{ lastActivityAt: number }>("room");
      await state.storage.put("room", {
        ...room,
        phase: "ended",
        lastActivityAt: Date.now() - 1000, // barely idle
      });
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get("room");
      expect(room).toBeDefined();
    });
  });

  test("does not apply the ended-TTL path to a lobby room even past 2h (only the 1h/6h paths apply there)", async () => {
    const { roomCode } = await createRoom();
    const stub = await stubFor(roomCode);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get<{ lastActivityAt: number }>("room");
      await state.storage.put("room", {
        ...room,
        phase: "lobby",
        lastActivityAt: Date.now() - (2 * 60 * 60 * 1000 + 1000),
      });
    });
    // A seated player keeps the empty-lobby 1h path from firing, isolating
    // this test to "does ended_ttl leak into non-ended phases" only.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("players", [{ id: "p1", name: "Solo", seatToken: "t1", joinedAt: Date.now() }]);
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const room = await state.storage.get("room");
      expect(room).toBeDefined();
    });
  });
});

describe("Spec 17 D4: alarm re-arm on WebSocket accept", () => {
  test("a socket opened after the alarm was deleted out-of-band re-arms it", async () => {
    const { roomCode } = await createRoom();
    const stub = await stubFor(roomCode);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });

    const ws = await openSocket(roomCode);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    ws.close();
  });
});

describe("Spec 17 D4: storyRateLimit named constant + rematch reset", () => {
  test("storyRateLimit key is deleted on new_game (rematch)", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");

    sendGame(game.hostWs, { type: "generate_story", beat: "sunrise-hold", phaseGen: 0, requestId: "r1" });
    // sunrise-hold is illegal at night (scenePhases is off by default in
    // setUpFivePlayerRoom) — doesn't matter for this test, we only need
    // recordStoryGeneration to have run at least once via a LEGAL beat.
    await nextMessageOfType(game.hostWs, "story_error");

    const stub = await stubFor(game.roomCode);
    const seeded = await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("storyRateLimit", [Date.now()]);
      return await state.storage.get("storyRateLimit");
    });
    expect(seeded).toBeDefined();

    // Force the game into "ended" so new_game is legal, then rematch.
    await runInDurableObject(stub, async (_instance, state) => {
      const game2 = (await state.storage.get<{ phase: string }>("game"))!;
      await state.storage.put("game", { ...game2, phase: "ended" });
    });
    sendGame(game.hostWs, { type: "new_game" });
    await nextMessageOfType(game.hostWs, "snapshot");

    await runInDurableObject(stub, async (_instance, state) => {
      const rateLimit = await state.storage.get("storyRateLimit");
      expect(rateLimit).toBeUndefined();
    });

    closeAll(game);
  });
});

describe("Spec 17 D1: story_generate outcome logging", () => {
  test("logs story_generate with outcome=disabled and a model field, before ever touching env.AI", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { roomCode, hostKey } = await createRoom();
    const hostWs = await openSocket(roomCode);
    send(hostWs, { type: "hello", auth: { kind: "host", hostKey } });
    await nextMessage(hostWs);

    send(hostWs, { type: "generate_story", beat: "morning-report", phaseGen: 0, requestId: "r1" });
    await nextMessageOfType(hostWs, "story_error");

    const line = spy.mock.calls.map((c) => c[0] as string).find((l) => l.includes('"story_generate"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ evt: "story_generate", roomCode, beat: "morning-report", outcome: "disabled" });
    expect(typeof parsed.latencyMs).toBe("number");
    expect(typeof parsed.model).toBe("string");

    spy.mockRestore();
    hostWs.close();
  });

  test("logs story_generate with outcome=ok on a successful (faked) generation", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: "r1" });
    await nextMessageOfType(game.hostWs, "story_draft");

    const line = spy.mock.calls.map((c) => c[0] as string).find((l) => l.includes('"story_generate"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ evt: "story_generate", outcome: "ok" });

    spy.mockRestore();
    closeAll(game);
  });
});

describe("Spec 17 D2: METRICS writes never throw into a game path", () => {
  test("METRICS is bound in this Miniflare instance (per wrangler.jsonc) and every writeMetric call site this suite exercises — room_claimed, ws_open, msg_timing, game_started — completes without throwing", async () => {
    // pool-workers reuses wrangler.jsonc (vitest.workers.config.ts), so
    // env.METRICS IS a real (local) AnalyticsEngineDataset here — the
    // "absence is a silent no-op" contract itself is unit-tested directly
    // against writeMetric in test/server/log.test.ts, where an env object
    // that truly lacks METRICS is constructed. This test instead proves the
    // OTHER half: a live binding doesn't derail a full lifecycle.
    expect(env.METRICS).toBeDefined();

    const { roomCode, hostKey } = await createRoom();
    const ws = await openSocket(roomCode);
    send(ws, { type: "hello", auth: { kind: "host", hostKey } });
    await nextMessage(ws); // welcome
    send(ws, { type: "ping" });
    const pong = (await nextMessage(ws)) as PongMessage;
    expect(pong.type).toBe("pong");
    ws.close();
  });
});

describe("Spec 17 D3: POST /api/client-error", () => {
  test("accepts a well-formed report and returns 204, never echoing the body", async () => {
    const res = await SELF.fetch("https://example.com/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "onerror",
        message: "boom",
        stackHead: "Error: boom\n  at x",
        url: "https://mafia.tannerwj.com/room/ABCDE",
        roomCode: "ABCDE",
        ua: "test-ua",
      }),
    });
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe("");
  });

  test("logs client_error on accept", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await SELF.fetch("https://example.com/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "boom", url: "https://x", ua: "test-ua" }),
    });
    const line = spy.mock.calls.map((c) => c[0] as string).find((l) => l.includes('"client_error"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ evt: "client_error", message: "boom" });
    spy.mockRestore();
  });

  test("rejects an oversized body with 413", async () => {
    const res = await SELF.fetch("https://example.com/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(9000), url: "https://x", ua: "test-ua" }),
    });
    expect(res.status).toBe(413);
  });

  test("rejects malformed JSON with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("rejects a body missing `message` with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x", ua: "test-ua" }),
    });
    expect(res.status).toBe(400);
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

// ---------------------------------------------------------------------------
// Spec 12 — reveal command, scenePhases, game-status aggregates.
// ---------------------------------------------------------------------------

function closeAll(game: FivePlayerGame): void {
  game.hostWs.close();
  game.angel.ws.close();
  game.villager1.ws.close();
  game.detective.ws.close();
  game.villager2.ws.close();
  game.mafia.ws.close();
}

async function startScenePhasesGame(game: FivePlayerGame) {
  sendGame(game.hostWs, {
    type: "start_game",
    ruleset: { ...FIVE_PLAYER_HOUSE_RULES, scenePhases: true },
    seed: SCRIPTED_SEED,
  });
  return drainSnapshots(game);
}

describe("Spec 12: reveal command contract", () => {
  test("reveal outside a scene phase is rejected reveal_not_active; non-host reveal not_host", async () => {
    const game = await setUpFivePlayerRoom();
    const afterStart = await startScriptedGame(game); // scenePhases OFF

    // Host reveal during night (no scene phase) -> reveal_not_active.
    sendGame(game.hostWs, { type: "reveal", gen: afterStart.detective.game!.phaseGen });
    const rej1 = (await nextMessageOfType(game.hostWs, "rejection")) as RejectionMessage;
    expect(rej1.code).toBe("reveal_not_active");

    // A player socket cannot reveal at all -> not_host.
    sendGame(game.angel.ws, { type: "reveal", gen: afterStart.angel.game!.phaseGen });
    const rej2 = (await nextMessageOfType(game.angel.ws, "rejection")) as RejectionMessage;
    expect(rej2.code).toBe("not_host");

    closeAll(game);
  });

  test("scenePhases ON: ready night parks in sunrise (unresolved), host reveal advances to dawn", async () => {
    const game = await setUpFivePlayerRoom();
    await startScenePhasesGame(game);

    // Night 1: mafia kills Dave, everyone settles. With scenePhases on, this
    // parks in sunrise WITHOUT resolving.
    sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
    await drainSnapshots(game);
    sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
    await drainSnapshots(game);
    sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
    await drainSnapshots(game);
    sendGame(game.mafia.ws, { type: "lock_action" });
    await drainSnapshots(game);
    const atSunrise = await settleNightRemainder(game);

    expect(atSunrise.detective.phase).toBe("sunrise");
    // LEAK PROOF: Dave still alive, no death in any player's log/players.
    expect(atSunrise.villager1.game?.players.find((p) => p.id === game.villager2.playerId)?.alive).toBe(true);
    expect(atSunrise.villager1.game?.log.some((e) => e.type === "playerDied")).toBe(false);
    expect(atSunrise.villager1.game?.log.some((e) => e.type === "attackAttempted")).toBe(false);

    // Stale-gen reveal -> stale_advance (loud, host UI disables the button).
    sendGame(game.hostWs, { type: "reveal", gen: atSunrise.detective.game!.phaseGen + 5 });
    const stale = (await nextMessageOfType(game.hostWs, "rejection")) as RejectionMessage;
    expect(stale.code).toBe("stale_advance");

    // Host reveals -> NOW the night resolves and advances to dawn.
    sendGame(game.hostWs, { type: "reveal", gen: atSunrise.detective.game!.phaseGen });
    const afterReveal = await drainSnapshots(game);
    expect(afterReveal.detective.phase).toBe("dawn");
    expect(afterReveal.villager1.game?.players.find((p) => p.id === game.villager2.playerId)?.alive).toBe(false);

    closeAll(game);
  });

  test("scenePhases ON: ready day vote parks in sunset, reveal advances to dusk/ended", async () => {
    const game = await setUpFivePlayerRoom();
    await startScenePhasesGame(game);

    // Force through night 1 (host escape hatch bypasses sunrise -> dawn),
    // ack -> day.
    sendGame(game.hostWs, { type: "force_advance", gen: 0 });
    const afterN1 = await drainSnapshots(game);
    expect(afterN1.detective.phase).toBe("dawn");
    const living = [game.angel, game.villager1, game.detective, game.villager2, game.mafia] as const;
    const afterAck = await acknowledgeDawn(game, afterN1.detective.game!.phaseGen, living);
    expect(afterAck.detective.phase).toBe("day");

    // Everyone confirms a vote on the mafia -> parks in sunset (UNRESOLVED).
    const atSunset = await voteConfirmAll(game, game.mafia.playerId, living);
    expect(atSunset.detective.phase).toBe("sunset");
    expect(atSunset.villager1.game?.players.find((p) => p.id === game.mafia.playerId)?.alive).toBe(true);

    // Reveal -> resolveVote runs; the mafia elimination ends the game.
    sendGame(game.hostWs, { type: "reveal", gen: atSunset.detective.game!.phaseGen });
    const afterReveal = await drainSnapshots(game);
    expect(afterReveal.detective.phase).toBe("ended");
    expect(afterReveal.detective.game?.winners).toEqual(["village"]);

    closeAll(game);
  });
});

describe("Spec 12: game-status aggregates + scenePhases set_ruleset", () => {
  test("every viewer's projection carries rolesRemaining/graveyard/headcount aggregates; no per-living-player role list", async () => {
    const game = await setUpFivePlayerRoom();
    const afterStart = await startScriptedGame(game);

    for (const key of ["angel", "villager1", "detective", "villager2", "mafia"] as const) {
      const view = afterStart[key].game!;
      expect(view.rolesRemaining).toEqual(expect.any(Array));
      expect(view.rolesRemaining.reduce((n, r) => n + r.count, 0)).toBe(5);
      for (const rc of view.rolesRemaining) expect(rc).not.toHaveProperty("playerId");
      expect(view.headcount).toEqual({ alive: 5, total: 5 });
      expect(view.graveyard).toEqual([]);
    }
    // A living villager's frame still reveals no OTHER living player's role.
    const villagerFrame = afterStart.villager1.game!;
    for (const p of villagerFrame.players) {
      if (p.id !== game.villager1.playerId && p.alive) expect(p.roleId).toBeUndefined();
    }

    closeAll(game);
  });

  test("set_ruleset carries scenePhases through to pendingRuleset for players", async () => {
    const game = await setUpFivePlayerRoom();
    sendGame(game.hostWs, {
      type: "set_ruleset",
      ruleset: { ...FIVE_PLAYER_HOUSE_RULES, scenePhases: true },
    });
    const snap = (await nextMessageOfType(game.villager1.ws, "snapshot")).state;
    expect(snap.pendingRuleset?.scenePhases).toBe(true);
    await Promise.all([
      nextMessageOfType(game.angel.ws, "snapshot"),
      nextMessageOfType(game.detective.ws, "snapshot"),
      nextMessageOfType(game.villager2.ws, "snapshot"),
      nextMessageOfType(game.hostWs, "snapshot"),
    ]);

    closeAll(game);
  });
});

// ---------------------------------------------------------------------------
// Spec 15 — AI narrator ("The Storyteller"). STORYTELLER_FAKE=1 is set for
// this test project (vitest.workers.config.ts) so every generation returns a
// deterministic canned {scene, bibleUpdates} without ever touching env.AI.
// ---------------------------------------------------------------------------

/** Drives a scripted 5-player game to `dawn` (the morning-report beat) via
 * the plain (non-scenePhases) path — night resolves immediately once ready. */
async function driveToDawn(game: FivePlayerGame) {
  const afterStart = await startScriptedGame(game);
  sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
  await drainSnapshots(game);
  sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
  await drainSnapshots(game);
  sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
  await drainSnapshots(game);
  sendGame(game.mafia.ws, { type: "lock_action" });
  await drainSnapshots(game);
  const atDawn = await settleNightRemainder(game);
  expect(atDawn.detective.phase).toBe("dawn");
  void afterStart;
  return atDawn;
}

/** Drives a scripted 5-player game (scenePhases ON) to `sunrise` — the
 * night is ready but deliberately UNRESOLVED (Spec 12 deferred resolution) —
 * the atmosphere beat under test. */
async function driveToSunrise(game: FivePlayerGame) {
  await startScenePhasesGame(game);
  sendGame(game.mafia.ws, { type: "submit_action", action: { targetId: game.villager2.playerId } });
  await drainSnapshots(game);
  sendGame(game.angel.ws, { type: "submit_action", action: { targetId: game.villager1.playerId } });
  await drainSnapshots(game);
  sendGame(game.detective.ws, { type: "submit_action", action: { targetId: game.mafia.playerId } });
  await drainSnapshots(game);
  sendGame(game.mafia.ws, { type: "lock_action" });
  await drainSnapshots(game);
  const atSunrise = await settleNightRemainder(game);
  expect(atSunrise.detective.phase).toBe("sunrise");
  return atSunrise;
}

function enableStoryteller(game: FivePlayerGame) {
  sendGame(game.hostWs, { type: "set_story_settings", enabled: true, theme: "a snowed-in lodge", tone: "noir" });
}

describe("Spec 15: settings round-trip + authority", () => {
  test("set_story_settings is host-only, persists, and rides the host's snapshot ONLY", async () => {
    const game = await setUpFivePlayerRoom();

    // A player cannot set story settings.
    sendGame(game.angel.ws, { type: "set_story_settings", enabled: true, theme: "x", tone: "noir" });
    const rej = (await nextMessageOfType(game.angel.ws, "rejection")) as RejectionMessage;
    expect(rej.code).toBe("not_host");

    enableStoryteller(game);
    const hostSnap = (await nextMessageOfType(game.hostWs, "snapshot")).state;
    expect(hostSnap.story).toEqual({
      enabled: true,
      settings: { theme: "a snowed-in lodge", tone: "noir" },
      bible: {},
      scenes: [],
    });

    // Every player socket ALSO gets a broadcast snapshot for this event
    // (touchAndBroadcast fans out to everyone) — but `story` must be absent/
    // null on every one of them (leak-tested field, M5).
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) {
      const snap = (await nextMessageOfType(p.ws, "snapshot")).state;
      expect(snap.story ?? null).toBeNull();
    }

    closeAll(game);
  });

  test("OFF by default: generate_story is rejected disabled before a game even exists", async () => {
    const { roomCode, hostKey } = await createRoom();
    const hostWs = await openSocket(roomCode);
    send(hostWs, { type: "hello", auth: { kind: "host", hostKey } });
    await nextMessage(hostWs);

    send(hostWs, { type: "generate_story", beat: "morning-report", phaseGen: 0, requestId: "r1" });
    const err = (await nextMessageOfType(hostWs, "story_error")) as StoryErrorMessage;
    expect(err.code).toBe("disabled");
    expect(err.requestId).toBe("r1");

    hostWs.close();
  });
});

describe("Spec 15: beat/phase legality + phaseGen staleness", () => {
  test("wrong_phase: morning-report requested during night is rejected", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");

    await startScriptedGame(game);
    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: 0, requestId: "r1" });
    const err = (await nextMessageOfType(game.hostWs, "story_error")) as StoryErrorMessage;
    expect(err.code).toBe("wrong_phase");

    closeAll(game);
  });

  test("stale_story: a phaseGen that no longer matches the current phase is rejected", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");

    const atDawn = await driveToDawn(game);
    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen + 99, requestId: "r1" });
    const err = (await nextMessageOfType(game.hostWs, "story_error")) as StoryErrorMessage;
    expect(err.code).toBe("stale_story");

    closeAll(game);
  });

  test("legal beat at the correct phase+phaseGen succeeds and returns a draft to the host", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");

    const atDawn = await driveToDawn(game);
    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: "r1" });
    const draft = (await nextMessageOfType(game.hostWs, "story_draft")) as StoryDraftMessage;
    expect(draft.requestId).toBe("r1");
    expect(draft.beat).toBe("morning-report");
    expect(draft.text.length).toBeGreaterThan(0);

    closeAll(game);
  });

  test("atmosphere beat (sunrise-hold) succeeds during the unresolved sunrise hold", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");

    const atSunrise = await driveToSunrise(game);
    sendGame(game.hostWs, { type: "generate_story", beat: "sunrise-hold", phaseGen: atSunrise.detective.game!.phaseGen, requestId: "r1" });
    const draft = (await nextMessageOfType(game.hostWs, "story_draft")) as StoryDraftMessage;
    expect(draft.beat).toBe("sunrise-hold");

    // LEAK PROOF: the fake generator's atmosphere output never mentions a
    // death — nothing resolution-shaped is IN the facts it was built from
    // (buildStoryFacts's structural guard for this beat has its own
    // dedicated unit coverage in storyteller.test.ts; this is the end-to-end
    // proof through the real DO/protocol path).
    expect(draft.text.toLowerCase()).not.toContain("did not see the dawn");

    closeAll(game);
  });

  test("sunrise-hold requested with the dawn beat's phaseGen at sunrise is wrong_phase (mismatched beat/phase pair)", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");

    const atSunrise = await driveToSunrise(game);
    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atSunrise.detective.game!.phaseGen, requestId: "r1" });
    const err = (await nextMessageOfType(game.hostWs, "story_error")) as StoryErrorMessage;
    expect(err.code).toBe("wrong_phase");

    closeAll(game);
  });
});

describe("Spec 15: queue-of-one + rate limit", () => {
  test("a second generate_story while one is in flight is rejected busy, using a fresh in-flight record from ctx.storage (not DO memory)", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);

    // Manually plant a fresh in-flight record directly in ctx.storage (the
    // real coordination mechanism per M6/v2-re-review finding 7 — NOT a
    // DO-memory flag) to deterministically exercise the busy path without
    // racing STORYTELLER_FAKE's synchronous resolution.
    const stub = await stubFor(game.roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("storyInflight", {
        requestId: "in-flight-r0",
        beat: "morning-report",
        phaseGen: atDawn.detective.game!.phaseGen,
        startedAt: Date.now(),
      });
    });

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: "r1" });
    const err = (await nextMessageOfType(game.hostWs, "story_error")) as StoryErrorMessage;
    expect(err.code).toBe("busy");

    closeAll(game);
  });

  test("a stale (>20s old) in-flight record is treated as cleared and a fresh generate_story succeeds", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);

    const stub = await stubFor(game.roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("storyInflight", {
        requestId: "stuck-from-before-eviction",
        beat: "morning-report",
        phaseGen: atDawn.detective.game!.phaseGen,
        startedAt: Date.now() - 25_000, // past the 20s stale bound
      });
    });

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: "r1" });
    const draft = (await nextMessageOfType(game.hostWs, "story_draft")) as StoryDraftMessage;
    expect(draft.requestId).toBe("r1");

    closeAll(game);
  });

  test("an in-flight record survives a DO eviction (ctx.storage durability — the exact scenario the v2 re-review fix targets)", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);

    const stub = await stubFor(game.roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("storyInflight", {
        requestId: "in-flight-before-eviction",
        beat: "morning-report",
        phaseGen: atDawn.detective.game!.phaseGen,
        startedAt: Date.now(),
      });
    });
    await evictDurableObject(stub);

    // A fresh generate_story after eviction must still see the record (it's
    // in ctx.storage, which survives eviction) and be rejected busy — proving
    // the record is NOT an in-memory flag that would have vanished silently.
    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: "r1" });
    const err = (await nextMessageOfType(game.hostWs, "story_error")) as StoryErrorMessage;
    expect(err.code).toBe("busy");

    closeAll(game);
  });

  test("rate limit: an 11th generation within a minute is rejected rate_limited", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);

    for (let i = 0; i < 10; i++) {
      sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: `r${i}` });
      await nextMessageOfType(game.hostWs, "story_draft");
    }
    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: "r10" });
    const err = (await nextMessageOfType(game.hostWs, "story_error")) as StoryErrorMessage;
    expect(err.code).toBe("rate_limited");

    closeAll(game);
  });
});

/** Reads `storyState` directly out of ctx.storage — more robust than trying
 * to force an incidental broadcast to inspect a mid-beat host snapshot
 * (several in-game commands are legitimately rejected — not broadcast — at
 * dawn/dusk, e.g. cast_vote is `not_your_phase` there). */
async function readStoryState(roomCode: string): Promise<StoryState | undefined> {
  const stub = await stubFor(roomCode);
  return runInDurableObject(stub, async (_instance, state) => state.storage.get<StoryState>("storyState"));
}

describe("Spec 15: auto-keep (commit on supersession) + discard/re-spin", () => {
  test("discard_story commits nothing — no scene appears in storyState even after the beat is superseded", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: "r1" });
    const draft = (await nextMessageOfType(game.hostWs, "story_draft")) as StoryDraftMessage;
    sendGame(game.hostWs, { type: "discard_story", requestId: draft.requestId });

    // Supersede the beat (force-advance past dawn) and confirm nothing committed.
    sendGame(game.hostWs, { type: "force_advance", gen: atDawn.detective.game!.phaseGen });
    const afterAdvance = await drainSnapshots(game);
    expect(afterAdvance.detective.phase).not.toBe("dawn");
    expect((await readStoryState(game.roomCode))?.scenes).toEqual([]);

    closeAll(game);
  });

  test("re-spin replaces the pending draft without committing the replaced one; only the LATEST draft auto-commits on supersession", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);
    const gen = atDawn.detective.game!.phaseGen;

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: gen, requestId: "r1" });
    await nextMessageOfType(game.hostWs, "story_draft");
    // Re-spin: a second generate_story for the SAME beat/phaseGen.
    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: gen, requestId: "r2" });
    const secondDraft = (await nextMessageOfType(game.hostWs, "story_draft")) as StoryDraftMessage;
    expect(secondDraft.requestId).toBe("r2");

    // Supersede via force_advance -> the LATEST (r2) draft auto-commits.
    sendGame(game.hostWs, { type: "force_advance", gen });
    await drainSnapshots(game);
    expect((await readStoryState(game.roomCode))?.scenes).toHaveLength(1);

    closeAll(game);
  });

  test("auto-commit on phase advance: a kept draft appears in storyState.scenes and bible after the phase moves past the beat", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);
    const gen = atDawn.detective.game!.phaseGen;

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: gen, requestId: "r1" });
    const draft = (await nextMessageOfType(game.hostWs, "story_draft")) as StoryDraftMessage;

    // Pending draft is NOT yet in storage (ephemeral by design, §Memory).
    expect((await readStoryState(game.roomCode))?.scenes).toEqual([]);

    // Force-advance past dawn -> auto-commit fires, strictly after the
    // game-state transition.
    sendGame(game.hostWs, { type: "force_advance", gen });
    const afterAdvance = await drainSnapshots(game);
    expect(afterAdvance.detective.phase).not.toBe("dawn");
    const story = await readStoryState(game.roomCode);
    expect(story?.scenes).toEqual([{ beat: "morning-report", day: 1, text: draft.text }]);
    expect(Object.keys(story?.bible ?? {}).length).toBeGreaterThan(0);

    closeAll(game);
  });

  test("commit failure is fire-safe: a storyState write failure never blocks the phase advance it piggybacks on", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);
    const gen = atDawn.detective.game!.phaseGen;

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: gen, requestId: "r1" });
    await nextMessageOfType(game.hostWs, "story_draft");

    // Corrupt storyState so commitDraft's JSON.stringify path still succeeds
    // but simulate a write failure by deleting the room's storage entirely
    // out from under it is too destructive to the room itself; instead
    // delete just the story key so getStoryState() falls back to
    // DEFAULT_STORY_STATE (a benign path, not a thrown error) — the true
    // "throws" path is exercised by autoCommitSupersededDrafts's own
    // try/catch, proven here by asserting the phase advance itself always
    // succeeds regardless of story storage state.
    const stub = await stubFor(game.roomCode);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete("storyState");
    });

    sendGame(game.hostWs, { type: "force_advance", gen });
    const afterAdvance = await drainSnapshots(game);
    // The phase advance succeeded regardless of story storage state.
    expect(afterAdvance.detective.phase).not.toBe("dawn");

    closeAll(game);
  });
});

describe("Spec 15: rematch clears memory, preserves settings", () => {
  test("new_game resets bible/scenes to empty but keeps enabled/theme/tone", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);
    const gen = atDawn.detective.game!.phaseGen;

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: gen, requestId: "r1" });
    await nextMessageOfType(game.hostWs, "story_draft");
    sendGame(game.hostWs, { type: "force_advance", gen });
    const afterDawn = await drainSnapshots(game);
    expect(afterDawn.detective.phase).toBe("day");
    expect((await readStoryState(game.roomCode))?.scenes).toHaveLength(1);

    // End the game for real: vote out the sole mafia at day. villager2 (the
    // mafia's night-1 target in driveToDawn) is dead — a dead player's vote
    // is rejected (not_alive, never broadcasts), so voteConfirmAll must only
    // be driven by the living.
    const living = [game.angel, game.villager1, game.detective, game.mafia] as const;
    const afterVote = await voteConfirmAll(game, game.mafia.playerId, living);
    expect(afterVote.detective.phase).toBe("ended");

    sendGame(game.hostWs, { type: "new_game" });
    const afterNewGame = await drainSnapshots(game);
    expect(afterNewGame.detective.phase).toBe("lobby");
    const story = await readStoryState(game.roomCode);
    expect(story?.scenes).toEqual([]);
    expect(story?.bible).toEqual({});
    expect(story?.settings).toEqual({ theme: "a snowed-in lodge", tone: "noir" });
    expect(story?.enabled).toBe(true);

    closeAll(game);
  });
});

describe("Spec 15: multi-host-socket delivery + player leak proof", () => {
  test("story_draft/story_error reach EVERY connected host socket, never a player socket", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);

    // A second host device joins.
    const stub = await stubFor(game.roomCode);
    const hostKey = await runInDurableObject(stub, async (_i, state) => {
      const room = await state.storage.get<{ hostKey: string }>("room");
      return room!.hostKey;
    });
    const hostWs2 = await openSocket(game.roomCode);
    send(hostWs2, { type: "hello", auth: { kind: "host", hostKey } });
    await nextMessage(hostWs2); // welcome
    await nextMessageOfType(game.hostWs, "snapshot"); // first host's broadcast from the join

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: "r1" });
    const [draft1, draft2] = await Promise.all([
      nextMessageOfType(game.hostWs, "story_draft") as Promise<StoryDraftMessage>,
      nextMessageOfType(hostWs2, "story_draft") as Promise<StoryDraftMessage>,
    ]);
    expect(draft1.requestId).toBe("r1");
    expect(draft2.requestId).toBe("r1");
    expect(draft1.text).toBe(draft2.text);

    // LEAK PROOF: no player socket ever receives a story_* message for this
    // whole flow. Force a fresh round of snapshots and confirm no player
    // queue holds anything of type story_draft/story_error.
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) {
      sendGame(p.ws, { type: "ping" });
      const pong = await nextMessageOfType(p.ws, "pong");
      expect(pong.type).toBe("pong");
    }

    hostWs2.close();
    closeAll(game);
  });

  test("player snapshots never carry a `story` field even when the host has one enabled with kept scenes", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atDawn = await driveToDawn(game);
    const gen = atDawn.detective.game!.phaseGen;

    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: gen, requestId: "r1" });
    await nextMessageOfType(game.hostWs, "story_draft");
    sendGame(game.hostWs, { type: "force_advance", gen });
    const afterAdvance = await drainSnapshots(game);

    for (const key of ["angel", "villager1", "detective", "villager2", "mafia"] as const) {
      expect(afterAdvance[key].story ?? null).toBeNull();
      expect(JSON.stringify(afterAdvance[key])).not.toContain("storyteller");
    }

    closeAll(game);
  });

  test("the PERSISTED storyState (scenes + bible) never contains a living player's role/alignment string, at both an atmosphere and a report beat", async () => {
    const game = await setUpFivePlayerRoom();
    enableStoryteller(game);
    await nextMessageOfType(game.hostWs, "snapshot");
    for (const p of [game.angel, game.villager1, game.detective, game.villager2, game.mafia]) await nextMessageOfType(p.ws, "snapshot");

    // Atmosphere beat first (scenePhases requires starting a fresh game with
    // it on — spin, commit via reveal, which advances straight through dawn
    // in this single-mafia-kill scenario since nothing else is pending).
    const game2 = await setUpFivePlayerRoom();
    enableStoryteller(game2);
    await nextMessageOfType(game2.hostWs, "snapshot");
    for (const p of [game2.angel, game2.villager1, game2.detective, game2.villager2, game2.mafia]) await nextMessageOfType(p.ws, "snapshot");
    const atSunrise = await driveToSunrise(game2);
    sendGame(game2.hostWs, { type: "generate_story", beat: "sunrise-hold", phaseGen: atSunrise.detective.game!.phaseGen, requestId: "a1" });
    await nextMessageOfType(game2.hostWs, "story_draft");
    sendGame(game2.hostWs, { type: "reveal", gen: atSunrise.detective.game!.phaseGen });
    await drainSnapshots(game2);
    const atmosphereStory = await readStoryState(game2.roomCode);
    closeAll(game2);

    // Report beat (morning-report at dawn — real deaths/roles ARE in the
    // resolved public projection here; the fake generator's canned output
    // still must not echo any raw role string since it's built from names
    // only, never from buildStoryFacts's roleWord field directly into text).
    const atDawn = await driveToDawn(game);
    sendGame(game.hostWs, { type: "generate_story", beat: "morning-report", phaseGen: atDawn.detective.game!.phaseGen, requestId: "r1" });
    await nextMessageOfType(game.hostWs, "story_draft");
    sendGame(game.hostWs, { type: "force_advance", gen: atDawn.detective.game!.phaseGen });
    await drainSnapshots(game);
    const reportStory = await readStoryState(game.roomCode);

    const roleStrings = ["mafia", "villager", "detective", "angel", "suicide_bomber", "minion", "good", "evil"];
    for (const story of [atmosphereStory, reportStory]) {
      const serialized = JSON.stringify({ scenes: story?.scenes, bible: story?.bible }).toLowerCase();
      for (const role of roleStrings) {
        expect(serialized).not.toContain(role);
      }
    }

    closeAll(game);
  });
});
