import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Server-side integration tests run inside workerd via the cloudflareTest()
// Vite plugin. Normally they reuse the deploy config; an isolated local
// config can be selected when a remote Workers AI preview is unavailable.
// Both configs must provide GAME_ROOMS and the v1 SQLite migration.
// `main` points the test isolate at the Worker entry so `SELF` (cloudflare:test)
// dispatches to the real fetch handler and its Durable Objects.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/server/index.ts",
      wrangler: {
        configPath: process.env.MAFIA_TEST_WRANGLER_CONFIG ?? "./wrangler.jsonc",
      },
      // Test-only: honors client-supplied `start_game.seed` so D4's scripted
      // games get a deterministic role assignment. Never set in
      // wrangler.jsonc itself (that file is also `wrangler deploy`'s
      // config) — this override only applies inside the pool-workers
      // Miniflare instance (Spec 03).
      //
      // Spec 15: STORYTELLER_FAKE mirrors the same mechanism — pool-workers
      // tests never call the real `env.AI` binding; the DO returns a
      // deterministic canned {scene, bibleUpdates} instead (see
      // src/server/storyteller.ts fakeStoryOutput). `wrangler dev`/Playwright
      // get the equivalent via `.dev.vars` (a different mechanism — that
      // file isn't read by Miniflare's test bindings).
      miniflare: { bindings: { ALLOW_TEST_SEED: "1", STORYTELLER_FAKE: "1" } },
    }),
  ],
  test: {
    name: "server",
    include: ["test/server/**/*.test.ts"],
  },
});
