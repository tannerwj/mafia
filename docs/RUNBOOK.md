# RUNBOOK — ops, logging, metrics

Spec 17. Two channels, two different jobs:

- **Structured logs** (`src/server/log.ts`'s `logEvent`) — one JSON line per
  event via `console.log`, captured by Cloudflare Workers Logs at
  `head_sampling_rate: 1` (every request, not sampled — traffic is tiny).
  Retention: 3 days on the free tier, 7 days on paid. Use these to
  investigate a SPECIFIC incident ("room ABCDE's narrator stopped working at
  14:32").
- **Metrics** (`src/server/metrics.ts`'s `writeMetric`, Cloudflare Analytics
  Engine, dataset `mafia_metrics`) — aggregate, queryable-over-time data
  points. Use these to answer trend questions ("what's our story_generate
  failure rate this week").

Both are operator-only. LOG HYGIENE (CLAUDE.md / spec 17 D1): never role
assignments keyed to a player, seat tokens, host keys, night-action targets,
vote contents, story text/theme, or player names. Player IDs and aggregate
counts are fine — this is enforced by `assertLogHygiene`
(`src/server/log-events.ts`) and unit-tested against every payload shape in
`test/server/log.test.ts`.

## Live tailing

```sh
wrangler tail mafia-game --format pretty
```

Add `--status error` to filter to thrown exceptions only, or grep the
pretty-printed output for an `evt` value (e.g. `wrangler tail mafia-game
--format json | jq 'select(.logs[0].message[0] | contains("story_generate"))'`
for the raw JSON form). Every `logEvent` line starts with `"evt"` as the
first JSON key specifically so eyeballing raw tail output is fast.

## The event list (D1)

| `evt` | Fields | When |
|---|---|---|
| `room_claimed` | `roomCode` | A room is claimed (`POST /api/rooms`) |
| `game_started` | `roomCode`, `playerCount`, `roleCounts` (aggregate counts per roleId — never per-player) | `start_game` succeeds |
| `game_ended` | `roomCode`, `winners`, `reason`, `day`, `durationMs` | The engine's `gameEnded` effect fires |
| `room_wiped` | `roomCode`, `reason` (`empty_lobby`\|`absolute_ttl`\|`ended_ttl`), `idleMs` | The alarm deletes a room's storage |
| `ws_open` | `roomCode`, `authKind` (`host`\|`seat`\|`join`) | A socket completes `hello` |
| `ws_close` | `roomCode`, `authKind`, `code`, `wasClean` | A socket closes |
| `ws_error` | `roomCode` | A socket errors |
| `auth_rejected` | `roomCode`, `reason` (`bad_host_key`\|`bad_seat_token`) | A `hello` is rejected |
| `msg_slow` | `roomCode`, `type`, `ms` | A `webSocketMessage` dispatch takes >50ms |
| `story_generate` | `roomCode`, `beat`, `outcome`, `latencyMs`, `model` | Every `generate_story` attempt, success or failure |
| `alarm_fired` | `roomCode`, `kind`, `driftMs` | A game-deadline alarm fires (`driftMs = Date.now() - scheduledAt`) |
| `client_error` | `roomCode?`, `message`, `stackHead`, `url`, `ua`, `kind` | `POST /api/client-error` accepts a report |

## Metrics dataset layout (D2)

Every `writeMetric` call site follows one convention: **`blobs[0]` is always
the metric name** (a discriminator, since every point in `mafia_metrics`
lands in the same flat table regardless of which event produced it) —
`blobs[1..]`, if any, are event-specific. `indexes[0]` is the room code when
one is known (used for `GROUP BY`/filtering to a single room's traffic).

| `blobs[0]` (metric name) | doubles | blobs[1..] | indexes |
|---|---|---|---|
| `game_started` | `[playerCount]` | — | `[roomCode]` |
| `game_ended` | `[day, durationMs]` | — | `[roomCode]` |
| `story_generate` | `[latencyMs]` | `[outcome, model]` | `[roomCode]` |
| `msg_timing` | `[ms]` | `[messageType]` | `[roomCode]` |
| `alarm_drift` | `[driftMs]` | — | `[roomCode]` |
| `client_error` | — | `[kind]` | `[roomCode]` if known |
| `room_wiped` | — | `[reason]` | `[roomCode]` |

`writeMetric` is a no-op when `env.METRICS` is absent (never throws — see
`test/server/log.test.ts`'s "METRICS binding absence" suite) and every call
site is wrapped so a throw from Analytics Engine itself can never break a
game path.

## Runbook SQL queries (Analytics Engine SQL API)

Endpoint: `POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql`
with header `Authorization: Bearer <API_TOKEN>` and the raw SQL string as
the request body. See [Cloudflare's SQL API
docs](https://developers.cloudflare.com/analytics/analytics-engine/sql-api)
for the full reference (functions, operators, `_sample_interval` weighting
for queries run against sampled data — not a concern here at
`head_sampling_rate: 1`, but Analytics Engine's OWN dataset writes can still
be internally sampled at high volume, hence `SUM(_sample_interval * ...)`
below being the safe default even though we don't currently rely on it).

### 1. Games per week

```sql
SELECT
  toStartOfWeek(timestamp) AS week,
  SUM(_sample_interval) AS games_started
FROM mafia_metrics
WHERE blob1 = 'game_started'
  AND timestamp > NOW() - INTERVAL '90' DAY
GROUP BY week
ORDER BY week DESC
```

### 2. story_generate p95 latency + failure rate by outcome

```sql
-- p95 latency (successful generations only — a "failure" doesn't have a
-- meaningful generation latency in the same sense; timeouts are pinned to
-- ~15s by construction).
SELECT
  quantile(0.95)(double1) AS p95_latency_ms,
  COUNT(*) AS n
FROM mafia_metrics
WHERE blob1 = 'story_generate' AND blob2 = 'ok'
  AND timestamp > NOW() - INTERVAL '7' DAY;

-- Failure rate by outcome.
SELECT
  blob2 AS outcome,
  SUM(_sample_interval) AS n,
  SUM(_sample_interval) / (
    SELECT SUM(_sample_interval) FROM mafia_metrics
    WHERE blob1 = 'story_generate' AND timestamp > NOW() - INTERVAL '7' DAY
  ) AS share
FROM mafia_metrics
WHERE blob1 = 'story_generate'
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY outcome
ORDER BY n DESC
```

### 3. Alarm drift p95 (are game-deadline alarms firing on time?)

```sql
SELECT
  quantile(0.95)(double1) AS p95_drift_ms,
  quantile(0.50)(double1) AS median_drift_ms,
  MAX(double1) AS max_drift_ms
FROM mafia_metrics
WHERE blob1 = 'alarm_drift'
  AND timestamp > NOW() - INTERVAL '7' DAY
```

## Diagnosing "the narrator stopped working"

1. `wrangler tail mafia-game --format pretty`, ask the reporter to retry, and
   watch for a `story_generate` line for their room code — the `outcome`
   field tells you exactly which of the nine failure classes it was
   (`timeout`/`parse_fail`/`model_error`/`rate_limited`/`busy`/`stale`/
   `wrong_phase`/`disabled`, or `ok` if it actually succeeded and the report
   is a client-side display issue instead — cross-check `client_error`).
2. If it's `rate_limited`: the room hit 10 generations/minute — expected
   under heavy host mashing, not a bug.
3. If it's `model_error` or `timeout` repeatedly across different rooms:
   check Workers AI status/quota, not this app.
4. If nothing shows up in tail at all for the room: the request likely never
   reached `generate_story` — check `ws_close`/`auth_rejected` for that room
   code around the same time (a stale/disconnected host socket is the
   most common cause).

## Diagnosing a client-side crash report

`client_error` logs carry `stackHead` (first 4KB) and `kind`
(`boundary`\|`onerror`\|`unhandledrejection`) — `boundary` means React's
render tree actually crashed (the player saw "THE CASE FILE JAMMED");
`onerror`/`unhandledrejection` mean the page kept running but something threw
outside render. Cross-reference `roomCode` + approximate timestamp against
the server-side `ws_*`/`story_generate` logs for the same room to see what
the server was doing at the same moment.
