# Spec 23 D1 backend implementation notes

## Implemented

- Added the closed `VisualTheme` protocol (`atelier`, `club`, `rain`), the runtime `isVisualTheme` guard, `set_visual_theme`, and required `visualTheme` / `visualThemeRevision` fields on every `ClientRoomState`.
- New rooms persist `atelier` at revision `0` in `RoomMeta`.
- Snapshot assembly normalizes legacy or malformed metadata through one helper. If either stored theme value or revision is missing/invalid, the public snapshot is `atelier` / `0`.
- `set_visual_theme` is host-only and lobby-only. Unknown values return `invalid_visual_theme`; players return `not_host`; in-game requests return `not_lobby`. Unchanged values return without a storage write or broadcast. Changed values use a Durable Object storage transaction, increment the revision, commit before `touchAndBroadcast`, and count as room activity.
- Rematch and room wipe paths require no special handling: theme metadata remains on `ROOM_KEY` through `new_game` and is removed by the existing `deleteAll()` wipe.
- The client store sends the new command and keeps the highest same-room visual-theme revision when an older snapshot arrives behind a newer host-tab update. Other game-state fields still apply from the incoming snapshot.

## Deviations and limits

- The server uses `ctx.storage.transaction` for the theme read/modify/write. It does not add a per-message `blockConcurrencyWhile`; Durable Object storage transactions are the concurrency gate for this update path.
- `invalid_visual_theme` is a `RejectionMessage.code` string, consistent with existing command rejections; `ErrorCode` is reserved for the existing `error` channel.
- Visual theme UI, document-level theme application, and browser E2E coverage belong to the concurrent client/orchestrator work. This change does not deploy or alter production state.

## Verification

- `npm run typecheck` — passed after the D1 changes.
- `npx vitest run --project server test/server/game-room.test.ts` — passed, 90 tests.
- Added server coverage for default metadata, all-socket synchronization, no-op selection, runtime validation and authorization, legacy fallback, host-tab revision convergence, in-game rejoin, and rematch persistence.

