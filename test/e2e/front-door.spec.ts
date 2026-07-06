import { expect, test, type Page } from "@playwright/test";

// Spec 16: landing explainer (D1) + QR join (D4). The existing hero
// (create-room/join-room/join-code-input testids) must stay untouched and
// is exercised by lobby.spec.ts/host-console.spec.ts already — this file
// only covers the NEW surfaces this spec adds.

async function createRoomAsHost(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByTestId("create-room").click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{5}$/);
  return page.url().split("/room/")[1]!;
}

test.describe("D1: landing explainer", () => {
  test("the hero stays exactly as before, above the fold", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("create-room")).toBeVisible();
    await expect(page.getByTestId("join-code-input")).toBeVisible();
    await expect(page.getByTestId("join-room")).toBeVisible();
  });

  test("explainer sections render below the fold with the house six", async ({ page }) => {
    await page.goto("/");
    const explainer = page.getByTestId("landing-explainer");
    await explainer.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("landing-pitch")).toBeVisible();
    await expect(page.getByTestId("landing-how-it-runs")).toBeVisible();
    await expect(page.getByTestId("landing-cast")).toBeVisible();
    await expect(page.getByTestId("landing-house-facts")).toBeVisible();

    const roles = page.getByTestId("landing-cast-role");
    await expect(roles).toHaveCount(6);
    const roleIds = await roles.evaluateAll((els) => els.map((e) => e.getAttribute("data-role-id")));
    expect(roleIds).toEqual(
      expect.arrayContaining(["villager", "mafia", "detective", "angel", "suicide_bomber", "minion"]),
    );
  });

  test("the footer link opens the case briefing without duplicating instruction copy", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("landing-how-it-works-link").scrollIntoViewIfNeeded();
    await page.getByTestId("landing-how-it-works-link").click();
    await expect(page.getByTestId("landing-instructions-modal")).toBeVisible();
    await expect(page.getByTestId("landing-instructions-modal")).toContainText("Objective");
    await page.getByTestId("landing-instructions-close").click();
    await expect(page.getByTestId("landing-instructions-modal")).toBeHidden();
  });
});

test.describe("D4: QR join", () => {
  test("host lobby shows a scannable QR encoding the room URL", async ({ page }) => {
    const roomCode = await createRoomAsHost(page);
    const qr = page.getByTestId("room-qr");
    await expect(qr).toBeVisible();
    const value = await qr.getAttribute("data-qr-value");
    expect(value).toContain(`/room/${roomCode}`);
    const title = await qr.getAttribute("title");
    expect(title).toContain(roomCode);
  });

  test("QR disappears once the game starts", async ({ page }) => {
    const roomCode = await createRoomAsHost(page);
    // The host isn't a seated player, so the 3-player start floor needs
    // three joined players (not two) — join Alice, Bob, AND Carol.
    const p1 = await (await page.context().browser()!.newContext()).newPage();
    const p2 = await (await page.context().browser()!.newContext()).newPage();
    const p3 = await (await page.context().browser()!.newContext()).newPage();
    for (const [p, name] of [[p1, "Alice"], [p2, "Bob"], [p3, "Carol"]] as const) {
      await p.goto(`/room/${roomCode}`);
      await p.getByTestId("join-name-input").fill(name);
      await p.getByTestId("join-name-submit").click();
    }
    await expect(page.getByTestId("host-player-table")).toContainText("Alice");
    await expect(page.getByTestId("host-player-table")).toContainText("Bob");
    await expect(page.getByTestId("host-player-table")).toContainText("Carol");

    await expect(page.getByTestId("room-qr")).toBeVisible();
    await page.getByTestId("start-game").click();
    await expect(page.getByTestId("room-qr")).toHaveCount(0);
  });
});
