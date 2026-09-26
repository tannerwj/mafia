import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.MAFIA_E2E_PORT ?? 5173);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./test/e2e",
  // Full-game scenarios chain several 25s phase-waits (real workerd alarms
  // can be slow under load) — the default 30s per-test budget contradicts
  // them. One slow beat must not fail a whole scenario.
  timeout: 120_000,
  fullyParallel: true,
  // Phase advances ride real workerd alarms on ONE shared dev server; at
  // high parallelism the alarms get starved past the tests' phase-wait
  // timeouts (observed: dawn->day flake at 6 workers, green at <=2).
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
