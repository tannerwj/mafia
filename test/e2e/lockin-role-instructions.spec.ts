import { expect, test, type Page } from "@playwright/test";

// Spec 08 D3/D4: team lock-in voting UI, persistent "My Role" button, and
// the Instructions/help modal. Follows the same harness pattern as
// game.spec.ts/game-components.spec.ts — seed 42 under HOUSE_RULES (5
// players, auto mafia formula) -> Alice:detective, Bob:mafia,
// Carol:suicide_bomber, Dave:angel, Erin:mafia (same mapping documented in
// game.spec.ts's scenario A comment block).

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

async function startGameWithSeed(hostPage: Page, seed: number) {
  await hostPage.evaluate((s) => {
    sessionStorage.setItem("mafia:testSeed", String(s));
  }, seed);
  await hostPage.getByTestId("start-game").click();
}

async function waitForPhase(page: Page, phase: string, timeout = 25_000) {
  await expect(page.getByTestId("game-screen")).toHaveAttribute("data-phase", phase, {
    timeout,
  });
}

async function waitForRoleRevealToClose(page: Page) {
  await expect(page.getByTestId("role-reveal-dialog")).toHaveCount(0, {
    timeout: 15_000,
  });
}

async function setUpFivePlayerGame(browser: import("@playwright/test").Browser, seed: number) {
  const hostCtx = await browser.newContext();
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const names = ["Alice", "Bob", "Carol", "Dave", "Erin"];
  for (let i = 0; i < names.length; i++) {
    await joinAsPlayer(pages[i]!, roomCode, names[i]!);
  }
  await startGameWithSeed(hostPage, seed);
  return {
    hostCtx,
    contexts,
    hostPage,
    roomCode,
    alice: pages[0]!,
    bob: pages[1]!,
    carol: pages[2]!,
    dave: pages[3]!,
    erin: pages[4]!,
    async closeAll() {
      await hostCtx.close();
      for (const c of contexts) await c.close();
    },
  };
}

test("lock-in: two mafia see each other's live tentative picks; night resolves only once both lock on the same target", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await waitForRoleRevealToClose(p);
  }

  // Bob picks Carol (tentative). Erin's screen must show Bob's own row
  // (identified by voter name "Bob", not target name -- Erin's own row
  // could later target the same person) with pick "Carol", unlocked.
  await game.bob.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  const bobPickOnErinScreen = game.erin
    .getByTestId("mafia-teammate-pick")
    .filter({ hasText: "Bob" });
  await expect(bobPickOnErinScreen).toContainText("Carol");
  await expect(bobPickOnErinScreen).toHaveAttribute("data-locked", "false");

  // Erin hasn't picked yet -- Bob's screen shows her as "deciding…".
  await expect(game.bob.getByTestId("mafia-teammate-picks")).toContainText("deciding");

  // A mismatched tentative pick never ends the night, even after Erin picks
  // a DIFFERENT target and neither has locked.
  await game.erin.getByTestId("night-target-option").filter({ hasText: "Dave" }).click();
  await expect(game.bob.getByTestId("mafia-consensus")).toHaveAttribute("data-consensus-reached", "false");
  await expect(game.alice.getByTestId("game-screen")).toHaveAttribute("data-phase", "night");

  // Erin changes her mind to match Bob's target (Carol) -- still tentative,
  // still must not resolve on its own even though the picks now match.
  await game.erin.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.bob.getByTestId("game-screen")).toHaveAttribute("data-phase", "night");
  await expect(game.bob.getByTestId("mafia-consensus")).toHaveAttribute("data-consensus-reached", "false");

  // Bob locks in -- still not enough alone.
  await game.bob.getByTestId("lock-in-button").click();
  await expect(game.bob.getByTestId("lock-in-button")).toHaveText("Unlock");
  const bobPickLockedOnErinScreen = game.erin
    .getByTestId("mafia-teammate-pick")
    .filter({ hasText: "Bob" });
  await expect(bobPickLockedOnErinScreen).toContainText("Carol");
  await expect(bobPickLockedOnErinScreen).toHaveAttribute("data-locked", "true");
  await expect(game.erin.getByTestId("mafia-consensus")).toContainText("1 of 2 locked");
  await expect(game.alice.getByTestId("game-screen")).toHaveAttribute("data-phase", "night");

  // Erin locks in too -- consensus reached. The night still needs Dave
  // (angel) and Alice (detective) to submit their own individual actions
  // before it fully completes.
  await game.erin.getByTestId("lock-in-button").click();
  await expect(game.bob.getByTestId("mafia-consensus")).toHaveAttribute("data-consensus-reached", "true");
  await expect(game.alice.getByTestId("game-screen")).toHaveAttribute("data-phase", "night");

  await game.dave.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await game.alice.getByTestId("night-target-option").filter({ hasText: "Bob" }).click();

  await waitForPhase(game.alice, "dawn", 25_000);

  await game.closeAll();
});

test("lock-in: unlocking BEFORE the second lock keeps the night open; re-locking resolves it", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await waitForRoleRevealToClose(p);
  }

  await game.bob.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.bob.getByTestId("lock-in-button")).toBeEnabled();
  await game.bob.getByTestId("lock-in-button").click();
  await expect(game.bob.getByTestId("lock-in-button")).toHaveText("Unlock");

  // Bob unlocks before Erin ever locks -- night must stay open even once
  // Erin later submits and locks (only 1 of 2 relevant killers is locked).
  await game.bob.getByTestId("lock-in-button").click(); // toggles back to Unlock -> Lock in
  await expect(game.bob.getByTestId("lock-in-button")).toHaveText("Lock in");

  await game.erin.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.erin.getByTestId("lock-in-button")).toBeEnabled();
  await game.erin.getByTestId("lock-in-button").click();
  await expect(game.alice.getByTestId("game-screen")).toHaveAttribute("data-phase", "night");

  // Bob locks back in -- now both are locked and agreed. Dave (angel) and
  // Alice (detective) still need to submit their own individual actions.
  await game.bob.getByTestId("lock-in-button").click();
  await game.dave.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await game.alice.getByTestId("night-target-option").filter({ hasText: "Bob" }).click();
  await waitForPhase(game.alice, "dawn", 25_000);

  await game.closeAll();
});

test("My Role button is reachable in every in-game phase and opens without leaving always-on role text", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  await waitForRoleRevealToClose(game.alice);

  // Privacy: before tapping, no role-identifying text is VISIBLE anywhere
  // in the rendered app root (structural, not a naive text grep — per the
  // spec, HoldToPeek's own content is present in the DOM but CSS-hidden
  // until pressed, which is the pre-existing, exempt pattern; `innerText()`
  // (unlike `innerHTML()`/`textContent()`) only returns rendered/visible
  // text, so it correctly ignores that hidden content while still catching
  // a genuine always-visible role badge). The auto-reveal dialog has
  // already closed by this point, and the My Role dialog hasn't opened.
  const visibleText = () => game.alice.locator("#root").innerText();
  expect(await visibleText()).not.toContain("Detective");

  const myRoleButton = game.alice.getByTestId("my-role-button");
  await expect(myRoleButton).toBeVisible();
  await myRoleButton.click();
  await expect(game.alice.getByTestId("my-role-dialog")).toContainText("Detective");
  await game.alice.getByTestId("my-role-dialog-close").click();
  await expect(game.alice.getByTestId("my-role-dialog")).toHaveCount(0);
  // Dismissed -- no permanent role text left visible.
  expect(await visibleText()).not.toContain("Detective");

  // Reachable through day phase too (skip past night quickly).
  await game.bob.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.bob.getByTestId("lock-in-button")).toBeEnabled();
  await game.bob.getByTestId("lock-in-button").click();
  await game.erin.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.erin.getByTestId("lock-in-button")).toBeEnabled();
  await game.erin.getByTestId("lock-in-button").click();
  await game.dave.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await game.alice.getByTestId("night-target-option").filter({ hasText: "Bob" }).click();

  await waitForPhase(game.alice, "dawn", 25_000);
  await expect(game.alice.getByTestId("my-role-button")).toBeVisible();

  await waitForPhase(game.alice, "day", 25_000);
  await expect(game.alice.getByTestId("my-role-button")).toBeVisible();
  await myRoleButton.click();
  await expect(game.alice.getByTestId("my-role-dialog")).toContainText("Detective");
  await game.alice.getByTestId("my-role-dialog-close").click();

  await game.closeAll();
});

test("dead players still have a working My Role button showing their real role", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await waitForRoleRevealToClose(p);
  }

  // Mafia (Bob+Erin) kill Carol; nobody protects her. With 5 players and 2
  // mafia, any single kill immediately reaches mafia parity (2 mafia vs 2
  // remaining town) -- win evaluation happens at the moment of the
  // night->dawn transition itself, so the game jumps straight from "night"
  // to "ended" (a real intermediate "dawn" phase is never observed for an
  // instant-win kill). That's fine for this test: the button only needs to
  // work for a dead viewer, regardless of whether the wider game is still
  // running or has just ended.
  await game.bob.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.bob.getByTestId("lock-in-button")).toBeEnabled();
  await game.bob.getByTestId("lock-in-button").click();
  await game.erin.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.erin.getByTestId("lock-in-button")).toBeEnabled();
  await game.erin.getByTestId("lock-in-button").click();
  await game.dave.getByTestId("night-target-option").filter({ hasText: "Bob" }).click();
  await game.alice.getByTestId("night-target-option").filter({ hasText: "Bob" }).click();

  await waitForPhase(game.carol, "ended", 25_000);

  const myRoleButton = game.carol.getByTestId("my-role-button");
  await expect(myRoleButton).toBeVisible();
  await myRoleButton.click();
  await expect(game.carol.getByTestId("my-role-dialog")).toContainText("Suicide Bomber");

  await game.closeAll();
});

test("Instructions modal opens from the lobby and in-game, and closes cleanly", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  await createRoomAsHost(hostPage);

  // Host lobby.
  await expect(hostPage.getByTestId("house-rules-summary")).toBeVisible();
  await hostPage.getByTestId("help-button").click();
  await expect(hostPage.getByTestId("instructions-modal")).toBeVisible();
  await expect(hostPage.getByTestId("instructions-modal")).toContainText("Objective");
  await expect(hostPage.getByTestId("instructions-role")).toHaveCount(6);
  await hostPage.getByTestId("instructions-close").click();
  await expect(hostPage.getByTestId("instructions-modal")).toHaveCount(0);

  await hostCtx.close();
});

test("Instructions modal is reachable mid-game and does not block gameplay", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  await waitForRoleRevealToClose(game.alice);

  await game.alice.getByTestId("help-button").click();
  await expect(game.alice.getByTestId("instructions-modal")).toBeVisible();
  await expect(game.alice.getByTestId("instructions-modal")).toContainText("Mafia lock-in");
  await game.alice.getByTestId("instructions-close").click();
  await expect(game.alice.getByTestId("instructions-modal")).toHaveCount(0);

  // Closing the modal doesn't interfere with normal play -- Alice
  // (detective) can still pick a target normally.
  await expect(game.alice.getByTestId("night-target-option").first()).toBeVisible();
  await game.alice.getByTestId("night-target-option").filter({ hasText: "Bob" }).click();

  await game.closeAll();
});
