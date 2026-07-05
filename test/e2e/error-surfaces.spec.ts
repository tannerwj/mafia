import { expect, test, type Page } from "@playwright/test";

// User-facing surfacing of errors that are already correctly REJECTED
// server-side but, before this spec, were never asserted to actually be
// SEEN by the user (playtest feedback: silent failures). Each test below
// asserts a visible message/screen, not just that a request round-tripped.

async function createRoomAsHost(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByTestId("create-room").click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{5}$/);
  return page.url().split("/room/")[1]!;
}

async function joinAsPlayer(page: Page, roomCode: string, name: string) {
  await page.goto(`/room/${roomCode}`);
  const joinAsNew = page.getByTestId("join-as-new");
  if (await joinAsNew.isVisible().catch(() => false)) {
    await joinAsNew.click();
  }
  await page.getByTestId("join-name-input").fill(name);
  await page.getByTestId("join-name-submit").click();
  await expect(page.getByTestId("player-list")).toContainText(name);
}

test("bad room code on Home shows a visible not-found message", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("join-code-input").fill("ZZZZZ");
  await page.getByTestId("join-room").click();

  await expect(page.getByTestId("home-error")).toBeVisible();
  await expect(page.getByTestId("home-error")).toContainText(/no case file/i);
  // Must not have navigated away from Home into a dead room page.
  await expect(page).toHaveURL(/\/$/);
});

test("duplicate name from a separate device shows room-error and does not join", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  const p1 = await p1Ctx.newPage();
  await joinAsPlayer(p1, roomCode, "Vinny");

  const p2 = await p2Ctx.newPage();
  await p2.goto(`/room/${roomCode}`);
  await p2.getByTestId("join-name-input").fill("Vinny");
  await p2.getByTestId("join-name-submit").click();

  await expect(p2.getByTestId("room-error")).toBeVisible();
  await expect(p2.getByTestId("room-error")).toContainText(
    "That name is already taken.",
  );
  // Still on the join form, never joined.
  await expect(p2.getByTestId("join-name-input")).toBeVisible();
  await expect(p2.getByTestId("player-list")).toHaveCount(0);

  await hostCtx.close();
  await p1Ctx.close();
  await p2Ctx.close();
});

test("duplicate name in a second tab of the same browser context shows room-error", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const sharedCtx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  const pageA = await sharedCtx.newPage();
  await joinAsPlayer(pageA, roomCode, "Sal");

  const pageB = await sharedCtx.newPage();
  await pageB.goto(`/room/${roomCode}`);
  // sharedCtx already holds a seat backup from pageA's join, so pageB lands
  // on the seat picker's backup list, not the join form directly — wait for
  // whichever one actually shows up rather than racing an isVisible() check
  // against the not-found lookup / seat-picker mount.
  await expect(
    pageB.getByTestId("join-as-new").or(pageB.getByTestId("join-name-input")),
  ).toBeVisible();
  const joinAsNewB = pageB.getByTestId("join-as-new");
  if (await joinAsNewB.isVisible().catch(() => false)) {
    await joinAsNewB.click();
  }
  await pageB.getByTestId("join-name-input").fill("Sal");
  await pageB.getByTestId("join-name-submit").click();

  await expect(pageB.getByTestId("room-error")).toBeVisible();
  await expect(pageB.getByTestId("room-error")).toContainText(
    "That name is already taken.",
  );

  await hostCtx.close();
  await sharedCtx.close();
});

test("case-insensitive duplicate name shows room-error", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  const p1 = await p1Ctx.newPage();
  await joinAsPlayer(p1, roomCode, "vinny");

  const p2 = await p2Ctx.newPage();
  await p2.goto(`/room/${roomCode}`);
  await p2.getByTestId("join-name-input").fill("Vinny");
  await p2.getByTestId("join-name-submit").click();

  await expect(p2.getByTestId("room-error")).toBeVisible();
  await expect(p2.getByTestId("room-error")).toContainText(
    "That name is already taken.",
  );

  await hostCtx.close();
  await p1Ctx.close();
  await p2Ctx.close();
});

test("joining after the game has started shows room-error", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  // HOUSE_RULESET's fixed role counts (Spec 04's game.spec.ts) only clear
  // validation at 5+ players — join 5 so "Start game" is actually reachable.
  const playerCtxs = await Promise.all(
    Array.from({ length: 5 }, () => browser.newContext()),
  );
  const names = ["Alice", "Bob", "Carol", "Dave", "Erin"];
  for (let i = 0; i < playerCtxs.length; i++) {
    const p = await playerCtxs[i]!.newPage();
    await joinAsPlayer(p, roomCode, names[i]!);
  }

  await hostPage.getByTestId("start-game").click();
  await expect(hostPage.getByTestId("host-phase-label")).toBeVisible();

  const latecomerCtx = await browser.newContext();
  const latecomer = await latecomerCtx.newPage();
  await latecomer.goto(`/room/${roomCode}`);
  await latecomer.getByTestId("join-name-input").fill("Frank");
  await latecomer.getByTestId("join-name-submit").click();

  await expect(latecomer.getByTestId("room-error")).toBeVisible();
  await expect(latecomer.getByTestId("room-error")).toContainText(
    "Cannot join once the game has started.",
  );

  await hostCtx.close();
  await Promise.all(playerCtxs.map((ctx) => ctx.close()));
  await latecomerCtx.close();
});

test("direct navigation to a nonexistent room code shows a not-found screen", async ({
  page,
}) => {
  await page.goto("/room/NOPE9");

  await expect(page.getByTestId("room-not-found")).toBeVisible();
  await page.getByRole("button", { name: /back to the office/i }).click();
  await expect(page).toHaveURL(/\/$/);
});
