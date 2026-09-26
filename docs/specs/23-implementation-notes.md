# Spec 23 — implementation summary

See [backend](23-backend-implementation-notes.md), [visual](23-visual-implementation-notes.md), and [game UX](23-game-implementation-notes.md) notes for file-level choices.

The host selects one of three public room-wide visual themes in the lobby. `ClientRoomState` carries the authoritative theme and monotonic revision. The Durable Object persists it in room metadata, validates host/lobby-only changes, and keeps it through rejoin and rematch. The client sets the skin on `document.documentElement` so dialogs, drawers, toasts, and texture inherit it. Home or a pre-snapshot room uses Atelier. No role, ruleset, vote, or private projection logic changed.

The shared UI now prioritizes phase and next action, room/seat state, a compact share path, role setup, and clear lock/vote feedback. Each theme uses local CSS and system fonts. The test runner can take a unique `MAFIA_E2E_PORT` and `MAFIA_E2E_STATE_DIR` so parallel runs do not share Durable Object state.

Final verification on 2026-09-26: `npm run typecheck` passed; `npm test` passed (200 engine, 54 client, 140 server); `npm run build` passed; the final isolated Playwright suite passed 55/55 in 2.3 minutes. Client assets changed from 130.19 KB JS + 7.08 KB CSS gzip to 134.46 KB JS + 10.45 KB CSS gzip. Deployed after a successful Wrangler dry run and verified with live browser sessions; see `STATUS.md` for the version and rollback ID. Real-browser screenshots and the review are in [the UI review](../reviews/2026-09-26-ui-themes.md).

STATUS: implemented, independently verified locally, deployed, and verified live.
