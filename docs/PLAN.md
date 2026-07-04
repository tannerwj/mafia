# Mafia — Rebuild Master Plan

**v1 — 2026-07-04 · Status: approved (Tanner, 2026-07-04)**

## Vision

A phone-first web app that acts as silent digital game master for private, in-person
Mafia games. A human **host** arbitrates from a god-view console; players connect
from their phones via a room link. No chat — pure deduction. Robust enough that
tab-switching, phone-sleeping, and reconnects never break a game; dynamic enough
that new roles and house rules are configuration, not code surgery.

The v0 implementation (commit `b8254a2` and earlier) is **retired** — it proved the
concept and the ideas live on in `design.md`, but the rebuild starts from scratch.

## Decisions log

| Date | Decision | By |
|---|---|---|
| 2026-07-04 | Full rewrite, including UI. v0 code retired to git history. | Tanner |
| 2026-07-04 | TypeScript everywhere; shared protocol types between client and server. | Tanner |
| 2026-07-04 | Platform stays Cloudflare Workers + Durable Objects (SQLite-backed) + WebSockets. | Tanner |
| 2026-07-04 | Host is a pure arbitrator, never a player. | Tanner |
| 2026-07-04 | Stall handling: optional per-phase timers (server alarms) + host force-advance always available. | Tanner |
| 2026-07-04 | Art direction: **noir/speakeasy** — near-black `#0c0a09`, blood red `#991b1b`, brass `#ca8a04`, serif display + clean sans body. | Tanner |
| 2026-07-04 | Client stack: Vite + React + Tailwind v4; shadcn/Radix primitives selectively (Dialog, Drawer, Button, Sonner). | Tanner |
| 2026-07-04 | Silent-gameplay principle retained (no in-app chat). | carried from design.md |

## Architecture

### Repo layout (single package)

```
src/
  shared/     # protocol.ts (client↔server messages), ruleset.ts (rules config
              # schema), types.ts — imported by BOTH client and server
  engine/     # pure TS game engine: no I/O, no Cloudflare imports, fully
              # unit-testable. State machine, night-resolution pipeline,
              # role registry, win evaluators, per-player visibility projection
  server/     # Worker entry + GameRoom Durable Object (hibernation, alarms,
              # storage). Thin: translates messages ⇄ engine calls
  client/     # Vite + React app (lobby, player views, host console)
test/
  engine/     # vitest unit tests (deterministic, seeded RNG)
  server/     # @cloudflare/vitest-pool-workers DO integration tests
  e2e/        # Playwright multi-context: full games, N browser contexts
docs/specs/   # the contracts (NN-<piece>.md + NN-implementation-notes.md)
```

### Identity (the #1 fix)

- **Player seat token**: on first join, server mints `{playerId, seatToken}`.
  `seatToken` is a secret; presenting it reclaims the seat — any phase, any
  device. Stored client-side in `sessionStorage` (canonical, per-tab → multiple
  tabs of one browser are distinct players, which makes local testing trivial)
  with a `localStorage` backup per room; a fresh tab that finds a backup offers
  "Rejoin as {name}?" vs "Join as new player".
- **Host key**: minted at room creation, returned once to the creator. Host
  connects by presenting it. No "no active host → anyone is authorized"
  fallbacks — v0's biggest security hole.
- Identity lives in the WebSocket attachment (`serializeAttachment`) so it
  survives DO hibernation; it is never inferred from connection order or name.

### Connection layer

- DO **WebSocket Hibernation API** (`ctx.acceptWebSocket`, `webSocketMessage`/
  `webSocketClose` handlers, `getWebSockets(tag)`) — sockets survive DO
  eviction; no in-memory session Map; no `setInterval` (v0 pinned the DO
  awake and still lost state).
- On every (re)connect the server sends a **complete personalized snapshot**
  (public state + your role + your private knowledge + pending action state).
  The client is a pure renderer of snapshots + deltas; it holds **no**
  authoritative game state and nothing game-critical in web storage.
- Client: auto-reconnect with backoff + jitter, re-auth with seat token on
  open, heartbeat ping, visibilitychange-triggered reconnect (phones killing
  background sockets is the common case, not the edge case).
- Room lifecycle/cleanup via **DO alarms**, not timers.

### Game engine (what makes "dynamic + custom rules" cheap)

- Pure-TS, deterministic (injected seeded RNG), event-logged. Engine consumes
  `(state, event) → (state', effects)`; the DO persists state and dispatches
  effects (messages, alarms).
- **Ruleset** = data, host-editable in lobby: role list & counts, per-phase
  timers, tie policy (runoff / no-murder-wins), reveal-role-on-death,
  mafia consensus mode (unanimous vs majority), no-murder option, first-night
  behavior, etc. Sensible defaults = our house rules from `design.md`.
- **Roles as data + small handlers**: a RoleDef declares alignment, night
  action type, action priority, targets, and visibility grants (e.g. minion
  sees mafia). Night resolution is an ordered pipeline (block → protect →
  kill → investigate → …). Adding a role = one RoleDef + at most one handler.
- Win conditions as evaluators run after every state change.
- Per-player **visibility projection** is a single pure function — the only
  place that decides who may see what. (v0 leaked via ad-hoc payloads.)

### Host console

God view (all roles, all pending actions), ruleset editor in lobby,
force-advance any phase (majority-so-far resolves; non-voters abstain),
pause/resume timers, kick (lobby) / mark-absent (mid-game), new-game reset.

### Verification strategy

- Engine: exhaustive vitest unit tests (seeded, deterministic).
- DO: vitest-pool-workers integration (connect/reconnect/hibernation paths).
- E2E: Playwright driving N browser contexts through complete games —
  the orchestrator's independent verification gate for every spec.
- Live: `wrangler dev` multi-tab smoke + deployed smoke before any close.

## Roadmap (specs)

| # | Spec | Contents |
|---|---|---|
| 00 | Scaffold | Vite+React+TS+Tailwind4, Wrangler, vitest(+pool-workers), Playwright, CI scripts. **Orchestrator-built** (needs network for installs). |
| 01 | Protocol, identity & room lifecycle | shared/protocol.ts, seat tokens, host key, hibernating DO, snapshots, reconnect, lobby (join/rejoin/kick), alarms cleanup. No game logic. |
| 02 | Engine core | State machine, ruleset schema, night pipeline, win evaluators, visibility projection, house-rules default ruleset, unit tests. Pure TS. |
| 03 | DO ⇄ engine integration | Wire engine into GameRoom, phase timers via alarms, host force-advance, personalized snapshot delivery. |
| 04 | Player UI | Noir theme tokens; lobby, role reveal, night-action drawer, day vote grid, dead/spectator view, end screen. |
| 05 | Host console | God view, ruleset editor, pacing controls. |
| 06 | Roles v1 + custom rules | House six (villager, mafia, detective, angel, suicide bomber, minion) + additions chosen from rules research; rule modifiers. |
| 07 | Polish | PWA + wake lock, QR join, sound/haptics cues, game history. |

Each spec: adversarial review (Codex) → build (Codex) → independent verify
(orchestrator: suites + Playwright + live) → commit + STATUS.md.

## Non-goals (v1)

Public matchmaking, accounts, in-app chat/voice, spectator links for
non-players, i18n, native apps.

## Open items

- Rules research report (in flight 2026-07-04) → informs Spec 02 ruleset
  schema breadth and Spec 06 role selection.
- Which additional roles make the v1 cut — Tanner picks from the research menu.
