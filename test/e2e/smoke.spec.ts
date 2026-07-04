import { expect, test } from "@playwright/test";

// Full-stack smoke: loading the page opens a WebSocket to a GameRoom Durable
// Object, sends a ping, and the pong round trip flips the status to ok. This
// proves client -> Worker -> DO -> WebSocket works end to end via `vite dev`.
test("ping-pong round trip reaches ok status", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Mafia" })).toBeVisible();

  const status = page.getByTestId("status");
  await expect(status).toHaveAttribute("data-status", "ok", { timeout: 15_000 });
});
