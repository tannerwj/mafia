// Bounded, local-only protocol and timing probe. Never prints credentials or game data.
const base = process.env.MAFIA_REVIEW_BASE_URL ?? "http://localhost:5319";
const url = new URL(base);
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
  throw new Error("Review probe only accepts a loopback URL");
}

const now = () => performance.now();
let stage = "setup";
const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
};
const summary = (values) => ({ n: values.length, p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95) });

class Peer {
  constructor(path) {
    this.socket = new WebSocket(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${path}`);
    this.frames = [];
    this.waiters = [];
    this.socket.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data);
      const waiter = this.waiters.find((entry) => entry.accept(frame));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      } else this.frames.push(frame);
    });
  }
  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }
  send(frame) { this.socket.send(JSON.stringify(frame)); }
  next(accept = () => true, timeoutMs = 5000) {
    const index = this.frames.findIndex(accept);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { accept, resolve: (frame) => { clearTimeout(timer); resolve(frame); } };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(entry), 1);
        reject(new Error(`Timed out waiting for local frame at ${stage}; queued=${this.frames.slice(-3).map((frame) => `${frame.type}:${frame.code ?? ""}`).join(",")}`));
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }
  close() { this.socket.close(); }
}

const create = async () => {
  const start = now();
  const response = await fetch(new URL("/api/rooms", url), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (response.status !== 201) throw new Error(`Create failed: ${response.status}`);
  return { ...(await response.json()), latencyMs: now() - start };
};
const connect = async (code, auth) => {
  const start = now();
  const peer = new Peer(`/api/rooms/${code}/ws`);
  await peer.open();
  peer.send({ type: "hello", auth });
  const welcome = await peer.next((f) => f.type === "welcome");
  return { peer, welcome, latencyMs: now() - start };
};
const ruleset = {
  roles: { mafia: 1, detective: 0, angel: 0, suicide_bomber: 0, minion: 0, villager: "auto" },
  mafiaCountFormula: "sqrt", firstNightKill: true, tiePolicy: "runoff-then-peace",
  dayVoteThreshold: "plurality", noMurderOption: true, mafiaConsensus: "unanimous",
  revealOnDeath: "full", parityRule: "immediate", votingVisibility: "hidden",
  scenePhases: false, timers: {}, dawnDuskBeatMs: 3000,
};

const peers = [];
try {
  stage = "create";
  const room = await create();
  stage = "host";
  const host = await connect(room.roomCode, { kind: "host", hostKey: room.hostKey });
  peers.push(host.peer);
  const unauth = new Peer(`/api/rooms/${room.roomCode}/ws`);
  peers.push(unauth);
  await unauth.open();
  unauth.send({ type: "kick", playerId: "arbitrary" });
  stage = "unauth rejection";
  const unauthResult = await unauth.next();
  if (unauthResult.code !== "not_authenticated") throw new Error("Unauthenticated command was not rejected");

  const joins = [], players = [], rosterWelcomeBytes = {};
  for (let i = 0; i < 20; i++) {
    stage = `join ${i + 1}`;
    const joined = await connect(room.roomCode, { kind: "join", name: `Review${i}` });
    peers.push(joined.peer);
    players.push(joined);
    joins.push(joined.latencyMs);
    if ([3, 5, 10, 20].includes(i + 1)) rosterWelcomeBytes[i + 1] = JSON.stringify(joined.welcome).length;
  }
  players[0].peer.send({ type: "kick", playerId: players[1].welcome.you.playerId });
  stage = "player kick rejection";
  const playerKick = await players[0].peer.next((f) => f.type === "error" || f.type === "rejection");
  if (playerKick.code !== "not_host") throw new Error("Player host command was not rejected");
  stage = "join 21";
  const extra = new Peer(`/api/rooms/${room.roomCode}/ws`);
  peers.push(extra);
  await extra.open();
  extra.send({ type: "hello", auth: { kind: "join", name: "Review20" } });
  const extraError = await extra.next((f) => f.type === "error");
  if (extraError.code !== "room_full") throw new Error(`21st join was not rejected: ${extraError.code}`);
  const extraClosed = await new Promise((resolve) => {
    if (extra.socket.readyState === WebSocket.CLOSED) return resolve(true);
    extra.socket.addEventListener("close", () => resolve(true), { once: true });
  });
  const rosterSize = players.at(-1).welcome.state.players.length;

  host.peer.send({ type: "start_game", ruleset });
  stage = "first player night snapshot";
  const firstGame = await players[0].peer.next((f) => f.type === "snapshot" && f.state?.game?.phase === "night");
  stage = "host night snapshot";
  const hostGame = await host.peer.next((f) => f.type === "snapshot" && f.state?.game?.phase === "night");
  const playerLeak = firstGame.state.game.log.some((entry) => entry.type === "gameStarted") || firstGame.state.game.players.some((p) => p.roleId);
  if (playerLeak) throw new Error("Private role assignment leaked to a living player");

  const commandLatencies = [];
  const mafiaId = hostGame.state.game.players.find((p) => p.roleId === "mafia")?.id;
  const actor = players.find((p) => p.welcome.you.playerId === mafiaId);
  const targetId = hostGame.state.game.players.find((p) => p.id !== mafiaId)?.id;
  if (!actor || !targetId) throw new Error("Could not select a valid action actor");
  let previousLogLength = hostGame.state.game.log.length;
  let lastSnapshot = hostGame;
  for (let i = 0; i < 10; i++) {
    stage = `repeated action ${i + 1}`;
    const start = now();
    actor.peer.send({ type: "submit_action", action: { targetId } });
    if (i === 0) {
      lastSnapshot = await host.peer.next((f) => f.type === "snapshot" && f.state?.game?.log?.length > previousLogLength);
      previousLogLength = lastSnapshot.state.game.log.length;
    } else {
      actor.peer.send({ type: "ping" });
      await actor.peer.next((f) => f.type === "pong");
    }
    commandLatencies.push(now() - start);
  }

  const missingAuth = new Peer(`/api/rooms/${room.roomCode}/ws`);
  peers.push(missingAuth);
  await missingAuth.open();
  missingAuth.send({ type: "hello" });
  let malformedHello = "no reply within 1s";
  try { const frame = await missingAuth.next(() => true, 1000); malformedHello = frame.type + (frame.code ? `:${frame.code}` : ""); } catch { /* recorded as no reply */ }
  let afterMalformed = "socket closed";
  if (missingAuth.socket.readyState === WebSocket.OPEN) {
    missingAuth.send({ type: "ping" });
    const followup = await missingAuth.next(() => true, 1000);
    afterMalformed = followup.type + (followup.code ? `:${followup.code}` : "");
  }

  console.log(JSON.stringify({
    environment: "isolated local workerd, fake Storyteller, no AI binding",
    createMs: Math.round(room.latencyMs), join: summary(joins),
    joinByRosterSize: { three: summary(joins.slice(0, 3)), five: summary(joins.slice(0, 5)), ten: summary(joins.slice(0, 10)), twenty: summary(joins) },
    lobbyWelcomeBytes: rosterWelcomeBytes,
    rosterAfter21Joins: rosterSize, join21: { code: extraError.code, closed: Boolean(extraClosed) },
    unauthCommand: unauthResult.code, playerHostCommand: playerKick.code,
    livingRoleLeak: false, malformedHello, afterMalformed,
    firstNightSnapshotBytes: { player: JSON.stringify(firstGame).length, host: JSON.stringify(hostGame).length },
    repeatedSameAction: { n: 10, roundTrip: summary(commandLatencies), hostLogDelta: previousLogLength - hostGame.state.game.log.length, lastHostSnapshotBytes: JSON.stringify(lastSnapshot).length },
  }, null, 2));
} finally {
  for (const peer of peers) peer.close();
}
