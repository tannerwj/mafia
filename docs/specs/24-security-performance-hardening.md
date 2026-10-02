# Spec 24 — Security and performance hardening

**2026-10-02 · Scope:** corrective work for the findings in [the review](../reviews/2026-10-02-findings.md). This addendum governs the protocol change below and the bounds added to the existing room lifecycle. It does not change player identity, role visibility, or the persisted game schema.

## Room and protocol bounds

- A lobby admits at most **20 player seats**. The 21st new join receives `error {code:"room_full"}` and closes; an existing seat token must still reconnect even when the roster is full. The host remains a non-player identity and may use multiple tabs.
- One room admits at most **64 live sockets**, including at most **32 pending authentication sockets**. The upgrade returns HTTP 429 with `Retry-After` when a bound is reached. The normal 30-second pending-auth reap remains in force. A refused upgrade does not create a pending-auth record.
- A WebSocket frame over **16 KiB of UTF-8 payload** receives `bad_message` and closes with code 1009 before JSON parsing. Binary frames remain unsupported. Valid JSON with malformed nested fields receives a bounded `bad_message` response. Unknown command types retain `unknown_type` behavior.
- `room_full` is added to `src/shared/protocol.ts`'s `ErrorCode` union; the existing generic client error rendering is sufficient. Existing `bad_host_key`, `bad_seat_token`, `name_taken`, and phase errors retain their meanings.
- Room-code API paths accept only five characters from the generated alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, case-insensitively. Malformed escapes and off-alphabet API codes return a client error before Durable Object lookup. A browser visit to a five-alphanumeric room URL still reaches the established not-found screen if no valid room exists.

## State and diagnostic bounds

- Repeating a command that leaves a tentative action, vote, or lock state unchanged returns the original engine state. No event is appended, no Durable Object game write occurs, and no personalized snapshot is broadcast. Submitting or casting the same target from a **locked** state intentionally reopens the choice and remains a transition.
- When a game is ended and no live sockets remain, the one Durable Object alarm slot includes `lastActivityAt + 2h`; the 6-hour absolute backstop still applies. Reconnect/activity and rematch recompute the alarm. The alarm handler remains the only place that wipes stored room state.
- `/api/client-error` reads at most 8 KiB of request bytes before JSON parsing. Logged diagnostic fields have finite lengths and the URL excludes query and fragment data. A malformed report never mutates game state.
- Storyteller settings and request fields have finite runtime limits; persona updates from model output are bounded and cannot use prototype keys. Existing host authorization, public-only AI context, and host-only draft delivery remain unchanged.
- Broadcast presence is computed once from the live socket set and reused for each personalized snapshot. Projection remains per viewer so no private game data is shared across seats.

## Verification and rollback

The branch must pass typecheck, build, server integration tests in an isolated local workerd configuration, and multi-context Playwright E2E including privacy, reconnect, and rematch flows. Regressions must cover the 21st seat, pending queue, malformed/oversized messages, no-op commands, ended-room alarm, bounded error ingestion, and malformed room paths. Review artifacts must not create production rooms or call real Workers AI.

Rollback before deployment is a revert of this branch. If a later deployment reveals compatibility trouble, revert the change as a unit; the branch introduces no persisted schema migration. Existing rooms with more than 20 seats retain their roster and can reconnect, but cannot add seats until below the cap. Live edge rate rules, event-history compaction, and Workers AI cancellation are separate decisions.
