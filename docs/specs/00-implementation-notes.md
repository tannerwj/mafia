# Spec 00 — Toolchain scaffold: implementation notes

Built by the orchestrator (needs network for installs). No game logic beyond a
ping/pong echo. Baseline commit `672e4ab`.

## Installed versions

| Package | Requested | Installed | Notes |
|---|---|---|---|
| vite | 7 | 7.3.6 | Pinned to `^7` per spec (8.1.3 is latest). |
| @vitejs/plugin-react | latest | 5.2.0 (`^5.1.4`) | **Version-forced:** plugin-react 6.x requires `vite@^8`. Pinned to 5.x, which supports `vite@^7`, to honor "Vite 7". |
| @cloudflare/vite-plugin | latest | 1.43.0 | Auto-discovers `wrangler.jsonc`; runs Worker + DO in workerd with HMR. |
| @tailwindcss/vite + tailwindcss | v4 | 4.3.2 | v4 via the `@tailwindcss/vite` plugin; CSS entry is a single `@import "tailwindcss";`. |
| wrangler | latest | 4.107.0 | Peer of the vite-plugin (`wrangler@4.107.0`). |
| @cloudflare/workers-types | latest | 4.20260702.1 (`^4`) | **Version-forced:** npm `latest` tag is `5.20260704.1`, but wrangler 4.107 declares `peerOptional @cloudflare/workers-types@^4`. Pinned to the 4.x line to avoid an ERESOLVE conflict. Runtime types for the Worker/DO actually come from the generated `worker-configuration.d.ts` (via `wrangler types`); this package supplies `/experimental` types for the DO test. |
| @cloudflare/vitest-pool-workers | latest | 0.18.0 | See config-API note below. |
| vitest | latest | 4.1.9 | pool-workers 0.18.0 peers `vitest@^4.1.0`. |
| @playwright/test | latest | 1.61.1 | Chromium installed via `npx playwright install chromium`. |
| typescript | latest | 6.0.3 | Strict, project references. |
| react / react-dom | 19 | 19.2.7 | |
| @types/react / @types/react-dom / @types/node | latest | 19.2.17 / 19.2.3 / 26.1.0 | react-dom types version on their own line (no 19.2.7). |

## Config decisions

- **Single npm package** at repo root (not a monorepo), `"type": "module"`.
- **wrangler.jsonc** replaces `wrangler.toml`. Preserved exactly as required:
  worker name `mafia-game`, DO binding `GAME_ROOMS` → class `GameRoom`, and the
  `v1` migration with `new_sqlite_classes: ["GameRoom"]` (kept compatible with
  the already-deployed worker).
- **`index.html` at repo root** — the location the Cloudflare/Vite plugin
  expects for the client entry. `main` in wrangler.jsonc points at
  `src/server/index.ts`.
- **vitest-pool-workers config API changed.** The Context7/older docs show
  `defineWorkersProject` / `defineWorkersConfig` imported from
  `@cloudflare/vitest-pool-workers/config`. In 0.18.0 that subpath no longer
  exists; the API is now a Vite plugin `cloudflareTest({ main, wrangler })`
  imported from the package root. `vitest.workers.config.ts` uses that; the DO
  test isolate loads the real Worker entry via `main` so `SELF` (from
  `cloudflare:test`) dispatches to `fetch` and the GameRoom DO.
- **Two vitest projects** via `vitest.config.ts` `test.projects`: `engine`
  (Node env) and `server` (workers pool, referenced file). `npm test` runs both
  sequentially with `--project`.
- **TypeScript project references** (`tsc --build`):
  - `tsconfig.client.json` — DOM libs, `react-jsx`, `src/client` + `src/shared`.
  - `tsconfig.server.json` — no DOM; `worker-configuration.d.ts` types;
    `src/server` + `src/engine` + `src/shared`.
  - `tsconfig.test-server.json` — DO test files; workers-types/experimental +
    `@cloudflare/vitest-pool-workers/types` (the `cloudflare:test` module).
  - `tsconfig.node.json` — Node-typed config files + engine/e2e tests. Includes
    `src/engine`/`src/shared` directly (pure TS) so the engine test resolves its
    import without a cross-project composite emit.
  - Strict everywhere, plus `noUncheckedIndexedAccess`,
    `exactOptionalPropertyTypes`, `noImplicitOverride`, `noUnused*`.

## Behavioral notes

- **DO WebSocket close code.** `webSocketClose` normalizes reserved codes
  (1005/1006/1015) to 1000 before echoing — a client `ws.close()` with no code
  surfaces as 1005 in the DO, which cannot be re-sent in a Close frame and
  otherwise throws `InvalidAccessError`. Found via the DO integration test.

## Deviations from the original wrangler.toml

- Dropped `main = "src/worker.js"` (retired v0 entry) → `src/server/index.ts`.
- Dropped the DO binding's `script_name = "mafia-game"` — only needed for
  cross-script DO references; a same-worker DO omits it (and the vite-plugin
  prefers it omitted). Binding name and class name are unchanged.
- Dropped `[env.production]` / `[env.development]` named environments — unused by
  any current tooling and not part of Spec 00 scope. Re-add later if needed.
- Bumped `compatibility_date` from `2024-01-01` to `2025-05-01` and added
  `nodejs_compat`, both required/recommended by the current vite-plugin toolchain.
- Added `assets.not_found_handling: "single-page-application"` (SPA fallback for
  client routes) and `observability.enabled`.

## Verification (all green)

- `npm install` — clean, 0 vulnerabilities (after the pins above).
- `npm run typecheck` — passes (all 4 tsconfig projects).
- `npm test` — engine 1/1, server (DO ping→pong) 1/1, no unhandled errors.
- `npm run dev` — serves the React page; `/api/rooms` returns 501; Worker + DO
  run in workerd alongside the client.
- `npm run test:e2e` — Playwright starts `vite dev` and drives the browser; the
  ping-pong round trip reaches `ok`, proving client ⇄ Worker ⇄ DO ⇄ WebSocket
  end to end.
- `npm run build` — builds both the Worker bundle (`dist/mafia_game`) and the
  client bundle (`dist/client`). Not deployed.

## Deferred (later specs)

- Real protocol, identity, snapshots, lobby, alarms — Spec 01.
- Engine state machine / ruleset — Spec 02.
- shadcn/Radix, zustand — not installed yet (Spec 04 / when needed).
