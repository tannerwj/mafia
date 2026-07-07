# Hotfix: stale `game_deadline` alarm hot loop

Live prod incident (room JH3KD, via `wrangler tail`): a Durable Object fired
its `game_deadline` alarm every ~85ms for 4+ hours, `driftMs` climbing past
15,362,000 (the age of that room's already-ENDED game). Server-only —
`src/server/game-room.ts` + `test/server/game-room.test.ts`.

## Root cause 1 — the hot loop

`alarm()`'s due-check (`src/server/game-room.ts`, "Game deadline" block) reads
`GAME_DEADLINE_KEY` fresh, and if it's due, applies `{ type: "timerExpired",
at: gameDeadlineAt }` via `applyGameResult`. The engine's `timerExpired`
handler (`src/engine/machine.ts:111`) validates `cmd.at === state.deadlineAt`
and no-ops (`{ state: input, effects: [] }`) otherwise — correct engine
behavior, since a deadline that no longer matches the live state shouldn't be
actioned. But `applyGameResult` treats `result.state === original` as "nothing
changed" and returns *before* `applyEffects` runs (`game-room.ts:1225-1227`),
so `clearDeadline`/`setDeadline` effects — the only things that ever touch
`GAME_DEADLINE_KEY` — never fire on a no-op.

The existing "stale alarm after a force-advance is a harmless no-op" test
(`game-room.test.ts`, `timer path and stale-alarm no-op`) is real and correct
for its case: force-advance arms a *newer* deadline before the stale alarm
fires, so `scheduleNextAlarm()` re-arms on that newer value, not the stale
one — genuinely harmless, no loop.

The prod case is different: the game had already reached `phase: "ended"`,
where `state.deadlineAt` is permanently `null` (`machine.ts:48-50`, `withWin`).
Once `GAME_DEADLINE_KEY` holds any past-due value at that point, `cmd.at` can
*never* again equal `state.deadlineAt` — every future firing is the same
no-op, forever. `scheduleNextAlarm()` (called unconditionally at the end of
`alarm()`) re-reads that same key, pushes it into `deadlines`, and re-arms
`Math.min(...deadlines)` on the same past timestamp it just proved stale —
Cloudflare fires again immediately. Infinite tight loop, matching the
observed ~85ms cadence exactly (85ms is roughly this Miniflare/workerd
round-trip's floor for an alarm armed in the past).

How the key survives to begin with isn't fully reproducible from the
available prod signal (a clean win *does* emit `clearDeadline` and it *does*
get applied, since that's a real transition, not a no-op) — candidates are a
crash/eviction between a `setDeadline` write and a later clearing command, or
any other edge case that leaves a stale value behind. The fix doesn't depend
on identifying which: **the alarm handler had no floor** — it never verified
that re-arming on a "due" key was actually going to make progress.

**Fix** (`game-room.ts`, alarm()'s game-deadline block): after applying the
due `timerExpired` and letting `applyGameResult` run, re-read
`GAME_DEADLINE_KEY`. If it's *still exactly the same value* we just proved
stale (i.e., the engine no-op'd and nothing in `applyEffects` touched it),
delete it ourselves before `scheduleNextAlarm()` runs. A real consumption
(the engine applied the timer and emitted `setDeadline`/`clearDeadline`) has
already changed or removed the key by that point, so this can never clobber
the legitimate case — confirmed by the untouched "harmless no-op" test still
passing (dawn's newer deadline is never equal to the stale night value the
spurious fire read, so my added check's `stillStale === gameDeadlineAt`
comparison is false and it's a no-op there too).

## Root cause 2 — `room.phase` / `ended_ttl` investigation (no bug found)

The brief asked me to check whether `RoomMeta.phase` is ever actually written
to `"ended"` in prod code, since the Spec 17 `ended_ttl` wipe path
(`room.phase === "ended" && idleMs >= ENDED_TTL_MS`) didn't rescue this room
after 2h idle, and the existing test plants `phase: "ended"` directly into
storage rather than driving a real game — a plausible way to mask dead code.

Traced it: `applyGameResult` (`game-room.ts:1234`) writes
`meta.phase = result.state.phase` on every real transition (i.e., whenever
`result.state !== original`, which is the same guard discussed above). A
genuine win goes through `withWin`, which is a real transition, so
`meta.phase` **does** get set to `"ended"` and persisted correctly today.
`room.phase` is not dead code; the `ended_ttl` condition reads the truth.

So this room's `ended_ttl` miss is explained by root cause 1 alone: the DO
never went idle long enough on the *ended_ttl* path to matter, because the
hot loop kept re-arming the alarm on the stale `game_deadline` every ~85ms,
and — more importantly — every one of those firings ran `applyGameResult`,
which calls `touchAndBroadcast`, which updates `lastActivityAt` on every
pass (`meta.lastActivityAt = Date.now()` at `game-room.ts:1235`, and
`touchAndBroadcast` itself touches it again unless `skipActivity` is set,
which this path doesn't set). The loop was continuously resetting its own
idle clock, so `idleMs >= ENDED_TTL_MS` could never become true. Fixing root
cause 1 also fixes this symptom directly — no separate `ended_ttl` code
change was needed or made.

I did add one thing: the existing three `ended_ttl` tests all poke
`room.phase = "ended"` directly and never prove a *real* finished game
leaves that value in storage. Left those three as-is (they correctly isolate
the TTL arithmetic) and added a fourth test that drives an actual game to
`"ended"` via `force_advance` + a direct-elimination vote (mirroring the
`new_game accepted once ended` test's shortcut), closes all sockets,
confirms `room.phase` really is `"ended"` in storage via the real path, then
backdates `lastActivityAt` and confirms the wipe still fires with
`reason: "ended_ttl"`.

## Diff summary

`src/server/game-room.ts` — one change, inside `alarm()`'s existing
game-deadline due-check block: after `await this.applyGameResult(result,
game)`, re-read `GAME_DEADLINE_KEY`; if it's unchanged from the value just
read as due, `ctx.storage.delete(GAME_DEADLINE_KEY)`. No other logic
touched; `ended_ttl` condition and `scheduleNextAlarm()` are unmodified —
both were already correct.

`test/server/game-room.test.ts` — two new tests:

1. `describe("timer path and stale-alarm no-op")` →
   `"hotfix regression: a stale gameDeadlineAt on an ENDED game is cleared,
   not re-armed into a hot loop"` — plays a real game to `"ended"`
   (`state.deadlineAt` confirmed `null`), closes sockets, plants a past-due
   `gameDeadlineAt` (using the prod-observed drift magnitude, 15,362,000ms,
   as the offset), runs the alarm once, asserts `GAME_DEADLINE_KEY` is gone,
   then runs the alarm again and asserts no second `game_deadline`-shaped key
   reappears (the direct reproduction + regression guard for the loop).
2. `describe("Spec 17 D4: ended-game TTL")` →
   `"wipes a room whose game reached 'ended' through a REAL play-through
   (not a manual phase poke), +2h idle"` — the root-cause-2 regression guard
   described above.

## Verification

- `npm run typecheck` — clean, no errors.
- `npm test`:
  - engine: 175 passed
  - client: 54 passed
  - server: 131 passed (129 pre-existing + 2 new), 0 failures
  - Total: 360 passed, 0 failed.
  - Note: the server run emits a pre-existing Miniflare/workerd teardown
    warning (`EnvironmentTeardownError: Closing rpc while "resolve" was
    pending`) after all tests report passed — confirmed present on a clean
    `git stash` of this same file at HEAD `96ee5e4` (81 tests passed there,
    same warning, same non-fatal shape). Not introduced by this change; does
    not affect pass/fail counts.
- No playwright/wrangler run performed per scope (server-only hotfix, tree
  left uncommitted for the orchestrator).

STATUS: COMPLETE
