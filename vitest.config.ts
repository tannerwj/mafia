import { defineConfig } from "vitest/config";

// Two projects:
//   engine  — pure-TS unit tests, default Node environment.
//   server  — Durable Object integration tests in the workerd runtime via
//             @cloudflare/vitest-pool-workers (config lives in its own file so
//             the pool can load the wrangler config).
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
      "./vitest.workers.config.ts",
    ],
  },
});
