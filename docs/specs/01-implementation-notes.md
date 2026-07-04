# Spec 01 — Protocol, identity & room lifecycle: implementation notes

Built against baseline `fa15e66`. All suites green (see report). Deviations
below are one-liners per the spec's own instruction; anything not listed here
matches the spec as written.

## Deviations

- **`getWebSockets()` includes just-closed sockets within the same
  synchronous turn.** Its `readyState` transitions to `CLOSING` immediately
  on `.close()`, but the socket isn't dropped from `getWebSockets()`'s
  bookkeeping until later. Every liveness/presence/broadcast check in
  `game-room.ts` therefore filters through a `liveSockets()` helper
  (`readyState === WebSocket.READY_STATE_OPEN`) instead of trusting raw
  `getWebSockets()` counts — otherwise a kick or auth-reap in the same turn
  as a presence/alarm recompute would see a phantom "still connected" socket.
  Not spelled out in the spec; discovered via the DO integration tests.
- **`touchAndBroadcast()` takes an `excludeWs` option**, used by all three
  `hello` success paths (host/seat/join) to skip re-sending a `snapshot` to
  the socket that just received `welcome` — `welcome` already carries the
  full state, so broadcasting to it again immediately after is a redundant
  duplicate that also made client message-ordering non-deterministic (a
  fresh `hello` producing two back-to-back messages to the same socket
  instead of one). Kick/leave/close broadcasts are unaffected (no exclusion).
- **Playwright's `context.setOffline(true)` does not sever an
  already-established WebSocket in Chromium** — it only blocks new
  connection attempts (maps to CDP `Network.emulateNetworkConditions`, which
  doesn't touch existing transport). The D6 socket-drop test therefore wraps
  `window.WebSocket` via `context.addInitScript` to track live sockets and
  force-closes them from the page before/alongside `setOffline(true)`, so the
  automatic reconnect attempt fails while offline and the banner appears —
  then `setOffline(false)` lets reconnect succeed. Confirmed via a throwaway
  probe script (not shipped) before landing this fix; the spec's own
  `page.setOffline(true/false)` wording undersells this gap.
- **Worker → DO internal routing** uses `https://do/internal/{claim,meta,ws}`
  as a synthetic base URL for `stub.fetch()` calls — the DO's `fetch` handler
  matches on pathname only, so the host is never actually dialed. Not called
  out explicitly in D2/D3 but implied by "internal claim endpoint... never
  reachable from a client directly."
- **DO constructor re-arms the alarm on cold start if none is set**
  (`ctx.blockConcurrencyWhile` checking `storage.getAlarm()` at construction).
  Guards against a crash landing between "write a deadline input" and "call
  `scheduleNextAlarm()`" in two separate turns, which would otherwise leave a
  due deadline with nothing armed to process it. `scheduleNextAlarm()` is
  idempotent (no-ops when there's no room or no deadline inputs), so this is
  safe to call unconditionally on every cold start.

## Commands the orchestrator should run

```
npm run typecheck   # tsc --build --force, all 4 project references
npm test            # vitest: engine (1) + server/DO integration (16)
npm run build       # vite build: worker bundle + client bundle
npm run test:e2e    # playwright: 6 multi-context lobby flows (test/e2e/lobby.spec.ts)
```

Live gate (per CLAUDE.md verification gates / spec's "Live" acceptance
criterion): `npm run dev`, then in one browser — create a room in tab A
(host), join from tabs B and C, join from a different browser profile D,
kill and reopen tab B and confirm it recovers the same seat, and confirm no
path admits a second "host" without the key.

## Static acceptance checks (all pass)

```
grep -r "innerHTML\|dangerouslySetInnerHTML" src/client        # no hits
grep -rn "setAlarm" src/server                                  # one call site, inside scheduleNextAlarm()
```

Protocol module (`src/shared/protocol.ts`) is imported by both
`src/server/game-room.ts` and `src/client/net/RoomConnection.ts` — no type
duplication.
