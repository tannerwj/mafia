# Spec 01 — Protocol, identity & room lifecycle

**v2 — 2026-07-04 · Status: approved for build**
Parent: PLAN.md §Architecture (Identity, Connection layer). Depends on: Spec 00 scaffold.
*v2 folds in all findings from Codex adversarial review (2026-07-04): claim
protocol replaces the fictional "DO exists" check; unified single-slot alarm
scheduler; auth-reap via alarm; wall-clock liveness; 4002 reclassified
retryable; kick atomicity; multi-seat device backups. No findings overruled.*

## Goal

Rooms that cannot lose people. A creator gets a room code + host key; players
join from phones and receive a secret seat token; any of them can kill the tab,
switch browsers, or let the phone sleep and then reconnect to exactly their
seat — in any phase. Done looks like: the Playwright suite drives three browser
contexts (two players + host) through join → disconnect → rejoin → kick, and
two tabs of the *same* browser are two distinct players.

## Non-goals

Game logic (phases beyond `lobby`, roles, votes) — Specs 02/03. Styled UI —
Spec 04 (this spec ships functional, unstyled React screens). Host console
beyond lobby basics — Spec 05. Message deltas/patching — snapshots are always
full (rooms are ≤ ~20 people; simplicity wins).

## Pinned conventions

- **Room code**: 5 chars from alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
  (no I/L/O/0/1), generated with `crypto.getRandomValues`. Case-insensitive on
  input (normalize to upper).
- **Tokens**: `seatToken` and `hostKey` are `crypto.randomUUID()` strings.
  Stored plaintext in DO storage (threat model: party game). Never included in
  any broadcast; only ever sent to their owner, once, at mint time.
- **Names**: 1–20 chars after trim; uniqueness case-insensitive within room;
  rendered only via React text nodes (never HTML).
- **WS protocol**: JSON text frames, discriminated unions on `type`, defined
  in `src/shared/protocol.ts`. Unknown `type` → `error{code:'unknown_type'}`,
  connection stays open. Malformed JSON → `error{code:'bad_message'}`.
- **Error shape**: `{type:'error', code: string, message: string}` — `code` is
  machine-readable (snake_case), `message` human-readable. Client logic keys
  on `code` only.
- **Close-code semantics** (client MUST implement exactly):
  | Code | Meaning | Client behavior |
  |---|---|---|
  | 4001 | kicked | terminal — show join screen, do not reconnect |
  | 4002 | auth timeout (`not_authenticated`) | **retryable timing failure** — normal reconnect backoff, re-send `hello`. NOT a credential verdict. |
  | 4003 | bad credential (`bad_host_key`/`bad_seat_token`) | terminal for that credential — discard it, fall back to join UI |
  | other/none | network/transient | normal reconnect backoff |
- **Snapshot semantics**: server → client state is always a *complete*
  personalized snapshot `{type:'snapshot', state: ClientRoomState}`. No deltas.
  Every state-changing event triggers a broadcast (each connection gets its
  own projection).
- **Timestamps**: epoch millis, server clock only.
- **Connected = has ≥1 live socket**: a player may hold multiple sockets
  simultaneously (e.g. two tabs presenting the same seat token — allowed; both
  render the same seat). Presence flag derived from
  `getWebSockets(playerTag(playerId)).length > 0`.
- **`lastActivityAt`** (persisted in storage): updated on *state-changing*
  events only — claim, join, rejoin-hello, leave, kick, (later: any game
  event). **Never** updated by `ping` or presence recomputation, or idle
  pinging tabs would immortalize abandoned rooms.

## Deliverables

**D1 — `src/shared/protocol.ts`**: complete typed protocol.

Client→server: `hello` (sent once immediately after WS open)
```ts
{type:'hello', auth:
  | {kind:'host', hostKey: string}
  | {kind:'seat', seatToken: string}
  | {kind:'join', name: string}}
```
plus `kick {playerId}` (host, lobby only), `leave {}` (voluntary, lobby only —
frees the name and the seat), `ping {}`.

Server→client: `welcome {you: {playerId?, seatToken?, isHost}, state}`
(seatToken present only when a seat was just minted), `snapshot {state}`,
`kicked {}` (then server closes with code 4001), `error {code, message}`,
`pong {}`.

`ClientRoomState` (lobby scope): `{roomCode, phase:'lobby', players:
[{id, name, connected, isYou}], hostConnected: boolean, createdAt}`.

**D2 — HTTP API** (Worker, in front of DO), with an explicit **claim
protocol** (there is no platform-level "DO already exists" — `idFromName` is a
pure hash; existence is an application concept):
- `POST /api/rooms {hostName?}`: Worker generates a code, calls the DO's
  internal `claim` endpoint. The DO checks its own storage key `room`:
  absent → write `{code, hostKey, createdAt, lastActivityAt}`, return
  `claimed {hostKey}`; present → return `taken`. Worker retries a fresh code
  on `taken`, max 5 attempts, then 500. Success → `201 {roomCode, hostKey}`
  (hostKey shown exactly once).
- `GET /api/rooms/:code` → `200 {exists, phase}` (exists = DO storage has
  `room`) or `404`.
- `GET /api/rooms/:code/ws` → WebSocket upgrade, forwarded to the DO.
  Upgrade is refused (`404`) if the room is unclaimed. All non-upgrade
  requests to this path → `426`.

**D3 — `GameRoom` DO** (hibernation-first):
- `ctx.acceptWebSocket(server, [tag])`; tags: `pending:<uuid>` at accept time,
  re-tagged conceptually via attachment on successful `hello` (Cloudflare tags
  are fixed at accept; the *attachment* is the identity authority:
  `{kind:'pending'|'host'|'player', playerId?, connectedAt}` via
  `serializeAttachment`). A persisted `pendingAuth` storage list
  `[{tagId, connectedAt}]` tracks unauthenticated sockets for reaping.
  Identity is *only* ever read from the attachment — never from
  client-supplied IDs.
- `hello` handling: `host` → verify hostKey (mismatch: `error{bad_host_key}` +
  close 4003). `seat` → look up seat token (unknown: `error{bad_seat_token}` +
  close 4003 — client discards token and falls back to join UI). `join` →
  validate name, reject duplicates (`error{name_taken}`), reject when
  `phase!=='lobby'` (`error{game_in_progress}`) — *rejoin by token is valid in
  any phase; only brand-new joins are lobby-gated*. Mint
  `{playerId, seatToken}`, persist, reply `welcome`, broadcast. On success:
  update attachment, remove from `pendingAuth`.
- Any non-`hello` message on a pending socket → `error{not_authenticated}` +
  close 4002.
- **Unified alarm scheduler** — the DO has ONE alarm slot; `setAlarm()`
  overwrites. All deadlines flow through a single
  `scheduleNextAlarm()` that computes and sets
  `min(authReapDeadlines…, emptyLobbyDeadline?, absoluteTtlDeadline)` where:
  - auth-reap: each `pendingAuth` entry expires at `connectedAt + 30s` —
    on fire, close expired pending sockets with 4002, drop entries;
  - empty-lobby: applies ONLY when `phase === 'lobby'` AND zero seated
    players — wipe at `lastActivityAt + 1h`;
  - absolute TTL: wipe at `lastActivityAt + 6h`.
  The `alarm()` handler processes every due deadline, then calls
  `scheduleNextAlarm()` to re-arm for the next soonest — the alarm is a
  scheduler tick, never one-shot-and-done. **Wipe rules:** never wipe while
  `getWebSockets().length > 0` (any live socket, including all-players-
  backgrounded-then-one-returns scenarios, keeps the room); zero sockets
  mid-game or with seated players is protected by the 6h TTL only (this is
  the everyone's-phone-locked case, NOT abandonment). `scheduleNextAlarm()`
  is called after every event that changes any deadline input.
- `webSocketClose`/`webSocketError` → drop any `pendingAuth` entry, recompute
  presence, broadcast, `scheduleNextAlarm()`.
- Kick (host, lobby only): remove player + token, `kicked` + close 4001 on all
  their sockets, broadcast. **Atomicity note for implementer:** the DO's
  event loop is single-threaded — do storage mutation and socket closes in
  the same synchronous handler turn (no `await` between them) so no `hello`
  presenting the removed seat token can interleave.
- No in-memory session state anywhere. No `setInterval`. Storage keys:
  `room` (meta + hostKey + lastActivityAt), `players` (map incl. seat
  tokens), `pendingAuth`.

**D4 — client connection layer** (`src/client/net/`):
- `RoomConnection`: opens WS, sends `hello` on open, exposes typed events;
  auto-reconnects with exponential backoff + full jitter (base 500ms, cap
  15s, unlimited attempts while page visible). Close-code handling exactly
  per the pinned table (4001/4003 terminal, 4002 and everything else
  retryable).
- **Liveness is wall-clock, not tick-count** (mobile browsers throttle/suspend
  timers: Chrome background tabs → 1 tick/min after 5 min; iOS Safari
  suspends JS and may tear the socket down at OS level with no event).
  Heartbeat: send `ping` when `now - lastSentAt > 25s` on whatever tick
  fires; declare dead when `now - lastMessageAt > 40s` *computed at check
  time*, never "missed N intervals". **The primary defense is the resume
  path, not the cadence**: on `visibilitychange→visible`, `pageshow`, and
  `online` → immediately check `readyState !== OPEN || now - lastMessageAt >
  40s` and force-recycle the socket if so.
- Identity storage: `sessionStorage['mafia:<code>:seat']` canonical (per-tab →
  multi-tab testing works by design). Device backup:
  `localStorage['mafia:<code>:seats']` is an **array** of
  `{seatToken, name, savedAt}` (shared devices are normal at a party — one
  phone may hold several people's seats). Fresh tab with no session value:
  offer "Rejoin as {name}" per backup entry + "Join as someone new".
  Joining as new **appends** to the array (never overwrites others); a 4003
  on a backup token removes that entry only. Host key:
  `sessionStorage['mafia:<code>:hostKey']` + single localStorage backup.
- No game/room state is ever persisted client-side — storage holds
  credentials only.

**D5 — minimal screens** (functional, unstyled beyond Tailwind defaults):
home (create room / join by code), lobby (player list with presence dots,
your name, host: kick buttons + room code + copy link), connection banner
(reconnecting…), seat-picker (backup entries, see D4). Route `/room/<code>`.

**D6 — tests**:
- pool-workers: claim → `claimed` then second claim → `taken` (Worker retry
  path); create→join→snapshot shape; duplicate name rejected;
  join-while-not-lobby rejected but seat-token rejoin accepted (fake a
  non-lobby phase by direct storage write); bad host key / bad seat token →
  close 4003; unauthenticated message → 4002; **auth-reap: connect, never
  hello, `runDurableObjectAlarm` → socket closed 4002 AND alarm re-armed for
  next-soonest deadline (not one-shot)**; kick removes seat + closes sockets
  (and a `hello` with the kicked token afterwards → 4003); presence flips on
  close; two sockets with same seat token both live;
  **hibernation survival: `evictDurableObject`, then message on surviving
  socket → identity intact from attachment**; empty-lobby wipe at +1h via
  alarm; NO wipe when zero sockets but players seated (6h TTL path only);
  NO wipe while any socket connected.
- Playwright: (a) host context creates room, two player contexts join;
  (b) player 1 reloads mid-lobby → same seat, no duplicate player;
  (c) two pages in ONE context (same browser) → two distinct players;
  (d) kick → kicked player sees join screen again, list updates everywhere;
  (e) socket drop (`page.setOffline(true/false)`) → banner → auto-reconnect →
  same seat; (f) seat-picker: join, close tab, reopen room URL → "Rejoin as
  {name}" offered; picking "someone new" preserves the first backup.

## Acceptance criteria

CI-verifiable (fresh clone, `npm i && npm test && npm run test:e2e`):
1. All D6 tests pass; `npm run typecheck` clean.
2. `grep -r "innerHTML\|dangerouslySetInnerHTML" src/client` → no hits.
3. Protocol module imported by both `src/server` and `src/client` (no type
   duplication).
4. `grep -rn "setAlarm" src/server` shows calls only inside the single
   `scheduleNextAlarm()` (one scheduler, no clobbering call sites).

Live (orchestrator): `vite dev`, then — create room in Chrome tab A (host);
join from tabs B and C; join from a different browser profile D; kill and
reopen B → same seat; verify no path lets a second "host" in without the key.

## Notes for implementer

- Dependency budget: zero new runtime deps (zustand arrives in Spec 04 if
  needed; React state suffices here).
- Read `docs/specs/00-implementation-notes.md` first for scaffold decisions.
- The DO must never trust `playerId` sent by a client — identity comes from
  the socket attachment established at `hello`.
- `serializeAttachment` limit is 16KiB — attachments hold identity only,
  never state.
- Deviations → `docs/specs/01-implementation-notes.md`, one-liners.
- Report: what's built, decisions, exact commands the orchestrator must run.
