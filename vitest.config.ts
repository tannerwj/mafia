import { defineConfig } from "vitest/config";

// Three projects:
//   engine  — pure-TS unit tests, default Node environment.
//   server  — Durable Object integration tests in the workerd runtime via
//             @cloudflare/vitest-pool-workers (config lives in its own file so
//             the pool can load the wrangler config).
//   client  — src/client/net unit tests (currently just RoomConnection's
//             reconnect state machine). No `jsdom` (not in Spec 04's closed
//             dependency budget) — these tests hand-roll the small
//             window/document/location/WebSocket surface RoomConnection
//             actually touches as plain globals, so plain Node environment
//             is sufficient; see tsconfig.client-test.json for the DOM-lib
//             typing this needs.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "engine",
          include: ["test/engine/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "client",
          include: ["test/client/**/*.test.ts"],
          environment: "node",
        },
      },
      "./vitest.workers.config.ts",
    ],
  },
});
