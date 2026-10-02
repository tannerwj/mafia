// Repeated local protocol timing: reconnect, host transition, alarm, fake AI.
const base = process.env.MAFIA_REVIEW_BASE_URL ?? "http://localhost:5319";
const url = new URL(base);
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("Loopback only");
const stamp = () => performance.now();
const stats = (values) => {
  const sorted = values.map((v) => Math.round(v)).sort((a, b) => a - b);
  return { n: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], valuesMs: sorted };
};
class Peer {
  constructor(code) {
    this.ws = new WebSocket(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/api/rooms/${code}/ws`);
    this.queue = [];
    this.waiters = [];
    this.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data);
      const index = this.waiters.findIndex((w) => w.accept(frame));
      if (index < 0) this.queue.push(frame);
      else this.waiters.splice(index, 1)[0].resolve(frame);
    });
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }
  next(accept, timeoutMs = 8000) {
    const index = this.queue.findIndex(accept);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { accept, resolve: (frame) => { clearTimeout(timer); resolve(frame); } };
      const timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter), 1); reject(new Error("Local timing frame timeout")); }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  send(frame) { this.ws.send(JSON.stringify(frame)); }
  close() { this.ws.close(); }
}
const connect = async (code, auth) => {
  const start = stamp();
  const peer = new Peer(code);
  await peer.open();
  peer.send({ type: "hello", auth });
  const welcome = await peer.next((f) => f.type === "welcome");
  return { peer, welcome, ms: stamp() - start };
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
  const response = await fetch(new URL("/api/rooms", url), { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  if (response.status !== 201) throw new Error(`Local create: ${response.status}`);
  const { roomCode, hostKey } = await response.json();
  const host = await connect(roomCode, { kind: "host", hostKey }); peers.push(host.peer);
  const playerAuth = [];
  for (let i = 0; i < 3; i++) {
    const p = await connect(roomCode, { kind: "join", name: `Timing${i}` });
    peers.push(p.peer);
    playerAuth.push({ kind: "seat", seatToken: p.welcome.you.seatToken });
  }
  host.peer.send({ type: "set_story_settings", enabled: true, theme: "", tone: "noir" });
  await host.peer.next((f) => f.type === "snapshot" && f.state?.story?.enabled === true);
  host.peer.send({ type: "start_game", ruleset });
  let current = await host.peer.next((f) => f.type === "snapshot" && f.state?.game?.phase === "night");

  const reconnect = [];
  for (let i = 0; i < 5; i++) {
    peers.at(-1).close();
    const p = await connect(roomCode, playerAuth[2]);
    peers.push(p.peer);
    reconnect.push(p.ms);
  }

  const force = [], alarm = [], fakeStory = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    let at = stamp();
    host.peer.send({ type: "force_advance", gen: current.state.game.phaseGen });
    const dawn = await host.peer.next((f) => f.type === "snapshot" && f.state?.game?.phase === "dawn" && f.state.game.phaseGen > current.state.game.phaseGen);
    force.push(stamp() - at);
    if (cycle === 0) {
      for (let i = 0; i < 5; i++) {
        const requestId = `local-${i}`;
        at = stamp();
        host.peer.send({ type: "generate_story", beat: "morning-report", phaseGen: dawn.state.game.phaseGen, requestId });
        await host.peer.next((f) => f.type === "story_draft" && f.requestId === requestId);
        fakeStory.push(stamp() - at);
      }
    }
    const day = await host.peer.next((f) => f.type === "snapshot" && f.state?.game?.phase === "day" && f.state.game.phaseGen > dawn.state.game.phaseGen);
    alarm.push(day.serverNow - dawn.state.game.deadlineAt);
    at = stamp();
    host.peer.send({ type: "force_advance", gen: day.state.game.phaseGen });
    const dusk = await host.peer.next((f) => f.type === "snapshot" && f.state?.game?.phase === "dusk" && f.state.game.phaseGen > day.state.game.phaseGen);
    force.push(stamp() - at);
    current = await host.peer.next((f) => f.type === "snapshot" && f.state?.game?.phase === "night" && f.state.game.phaseGen > dusk.state.game.phaseGen);
    alarm.push(current.serverNow - dusk.state.game.deadlineAt);
  }
  console.log(JSON.stringify({ environment: "isolated local workerd; 3 players; 3-second dawn/dusk; fake Storyteller", reconnect: stats(reconnect), hostForceToSnapshot: stats(force), alarmServerTimestampDrift: stats(alarm), fakeStoryDraft: stats(fakeStory) }, null, 2));
} finally { for (const peer of peers) peer.close(); }
