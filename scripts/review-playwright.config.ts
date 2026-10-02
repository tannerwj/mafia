import { defineConfig, devices } from "@playwright/test";

// Run against an already running, isolated local Worker (see review-local.sh).
const port = Number(process.env.MAFIA_REVIEW_PORT ?? 5319);

export default defineConfig({
  testDir: "../test/e2e",
  timeout: 120_000,
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: { baseURL: `http://localhost:${port}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
