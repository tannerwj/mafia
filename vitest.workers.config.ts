import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Server-side integration tests run inside workerd via the cloudflareTest()
// Vite plugin. It reuses the same wrangler config as dev/deploy, so the
// GAME_ROOMS Durable Object binding and the v1 SQLite migration are available.
// `main` points the test isolate at the Worker entry so `SELF` (cloudflare:test)
// dispatches to the real fetch handler and its Durable Objects.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/server/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      // Test-only: honors client-supplied `start_game.seed` so D4's scripted
      // games get a deterministic role assignment. Never set in
      // wrangler.jsonc itself (that file is also `wrangler deploy`'s
      // config) — this override only applies inside the pool-workers
      // Miniflare instance (Spec 03).
      miniflare: { bindings: { ALLOW_TEST_SEED: "1" } },
    }),
  ],
  test: {
    name: "server",
    include: ["test/server/**/*.test.ts"],
  },
});
