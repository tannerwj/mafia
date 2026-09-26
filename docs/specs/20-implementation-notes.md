# Spec 20 implementation notes

## Implemented

- `RoomConnection.send` now returns whether the socket accepted a command. The
  client store shows one `Connection lost. Reconnect, then try again.` toast for
  blocked consequential sends and clears the suppression on a successful
  reconnect. Commands are never queued or applied optimistically.
- Replaced the landing page's handwritten instructions dialog with the shared
  Radix dialog behavior while preserving the landing test IDs and backdrop
  dismissal. Keyboard focus enters, remains trapped, closes with Escape, and
  returns to the opener.
- Corrected the night instructions to describe the uniform pick-and-confirm
  flow and inert `Keep watch` decoys.
- Added `HelpButton` to direct seat picking, labeled the name input, associated
  validation text, and marked validation errors as alerts.
- Renamed the day option to `No murder this round` without changing its wire
  target.
- Added status semantics to the reconnect banner and visible focus indicators
  for hand-written controls.
- Kept host subject names readable at phone widths by allowing the name/role
  cluster to wrap and disabling ellipsis truncation below the desktop breakpoint.

## Verification

The focused E2E runs used an isolated Vite/Cloudflare state directory and port
5187 (temporary config outside the repository):

```sh
npx playwright test test/e2e/front-door.spec.ts --config=/tmp/mafia-playwright-spec20.config.ts
npx playwright test test/e2e/game-reconnect.spec.ts -g "kill network mid-night" --config=/tmp/mafia-playwright-spec20.config.ts
```

Observed results:

- `front-door.spec.ts`: 6 passed, including the new keyboard dialog test.
- `game-reconnect.spec.ts -g "kill network mid-night"`: 1 passed, including
  blocked-send feedback, one-toast suppression, and no fake lock after
  reconnect.
- `mobile-viewport.spec.ts`: 1 passed, including the new host-name clipping
  assertion at 360px.
- `npm run typecheck`: passed.
- Direct browser geometry probe at 320px and 360px reported modal CSS widths
  of 288px and 328px respectively, with roughly 16px side margins; the
  `calc(100%-2rem)` utility resolves correctly in the runtime Tailwind CSS.

No protocol, engine, server, ruleset, or deployment changes were made for this
spec. Full repository verification remains with the orchestrator.
