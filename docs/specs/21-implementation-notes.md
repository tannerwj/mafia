# Spec 21 implementation notes — server test teardown

Built against HEAD `db47adc`. Test-only cleanup; no application source or
protocol behavior changed.

## Failure and root cause

`npx vitest run --project server test/server/game-room.test.ts` reproduced a
failure after all 83 assertions passed:

```text
EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending
```

The suite intentionally creates real hibernating WebSockets and schedules
Durable Object alarms. Test calls to `WebSocket.close()` are synchronous from
the test's point of view, but the server's `webSocketClose()` callback awaits
storage, broadcasts presence, and re-arms alarms. That work can still be
running when Vitest closes the worker RPC. Miniflare also reported a canceled
SQLite alarm immediately before the teardown error.

The failure was confirmed twice before the change. Adding cleanup only to
three validation tests that had forgotten to close their sockets did not fix
the suite, so the root cause was the suite-wide pending DO lifecycle rather
than one leaked socket. A focused hypothesis test adding
`abortAllDurableObjects()` in `afterAll` made the same run exit cleanly.

## Change

`test/server/game-room.test.ts` now imports `abortAllDurableObjects` from
`cloudflare:test` and awaits it in a file-level `afterAll`. This aborts running
Durable Object instances so their pending alarm/close callbacks cannot outlive
the worker RPC. It does not delete test storage and does not alter production
behavior.

## Verification

- Before: 83 passed, 1 unhandled `EnvironmentTeardownError`, exit 1.
- After focused run: 83 passed, 0 errors, exit 0.
- The expected command is:

  ```sh
  npx vitest run --project server test/server/game-room.test.ts
  ```

Run the repository-wide `npm test` gate from the orchestrator after this
test-only change is present.

## Deviation

The implementation does not rewrite every existing socket close call to await
the client close event. The file-level DO abort is the smallest reliable
boundary because the server close callback also performs asynchronous storage,
broadcast, and alarm work that a client-side close event alone cannot prove has
finished.
