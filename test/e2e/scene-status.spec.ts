import { expect, test, type Page } from "@playwright/test";

// Spec 12 E2E (D4): sunrise/sunset narrator-gated reveal + player holding
// screen; the all-player game-status panel (graveyard + remaining role counts);
// the host narrator board (who hasn't locked, day + night). Built on the
// game.spec.ts pattern: one browser context per player, deterministic via the
// env-gated start_game.seed.
//
// scenePhases is enabled through the REAL host lobby toggle (`scene-phases-
// toggle`), so these tests deliberately do NOT stash a `mafia:testRoles`
// override — that override forces the HOUSE_RULESET shape (scenePhases:false).
// Instead they let the host lobby's own editor ruleset (scenePhases:true, and
// its editor role mix: 1 mafia / 1 detective / 1 angel / 1 bomber / 1 villager
// for 5 players) flow through. Seed 42 under THAT mix deals:
//   Alice:mafia, Bob:villager, Carol:angel, Dave:detective, Erin:suicide_bomber
// (verified against startGame with the editor ruleset).

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

// Enable scenePhases via the real toggle, set the seed, then start — WITHOUT a
// testRoles override, so the editor's scenePhases:true ruleset is what's sent.
async function startScenePhasesGame(hostPage: Page, seed: number) {
  await hostPage.evaluate((s) => sessionStorage.setItem("mafia:testSeed", String(s)), seed);
  const toggle = hostPage.getByTestId("scene-phases-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await hostPage.getByTestId("start-game").click();
}

async function waitForPhase(page: Page, phase: string, timeout = 25_000) {
  await expect(page.getByTestId("game-screen")).toHaveAttribute("data-phase", phase, { timeout });
}

async function waitForRoleRevealToClose(page: Page) {
  await expect(page.getByTestId("role-reveal-dialog")).toHaveCount(0, { timeout: 15_000 });
}

async function submitAndLockMafiaTarget(page: Page, targetName: string) {
  await page.getByTestId("night-target-option").filter({ hasText: targetName }).click();
  const lock = page.getByTestId("lock-in-button");
  await expect(lock).toBeEnabled();
  await lock.click();
}

async function submitAndConfirmNightTarget(page: Page, targetName: string) {
  await page.getByTestId("night-target-option").filter({ hasText: targetName }).click();
  const confirm = page.getByTestId("night-confirm-button");
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

async function settleWatch(page: Page, targetName: string) {
  const option = page.getByTestId("night-watch-option").filter({ hasText: targetName });
  await expect(option.first()).toBeVisible();
  await option.first().click();
  const confirm = page.getByTestId("night-confirm-button");
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

async function acknowledgeMorning(page: Page) {
  const button = page.getByTestId("acknowledge-button");
  if (await button.isVisible().catch(() => false)) await button.click();
}

test.describe("Spec 12: sunrise/sunset narrator-gated reveal + holding screen", () => {
  test("players hold at a neutral scene screen until the host reveals; no outcome leaks pre-reveal", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const ctxs = await Promise.all([0, 1, 2, 3, 4].map(() => browser.newContext()));
    const hostPage = await hostCtx.newPage();
    const roomCode = await createRoomAsHost(hostPage);
    const [alice, bob, carol, dave, erin] = await Promise.all(ctxs.map((c) => c.newPage()));

    await joinAsPlayer(alice!, roomCode, "Alice");
    await joinAsPlayer(bob!, roomCode, "Bob");
    await joinAsPlayer(carol!, roomCode, "Carol");
    await joinAsPlayer(dave!, roomCode, "Dave");
    await joinAsPlayer(erin!, roomCode, "Erin");

    await startScenePhasesGame(hostPage, 42);

    await waitForPhase(alice!, "night");
    for (const p of [bob!, carol!, dave!, erin!]) await waitForPhase(p, "night");

    // Editor mix seed 42: Alice:mafia, Bob:villager, Carol:angel, Dave:detective,
    // Erin:suicide_bomber.
    await expect(alice!.getByTestId("role-reveal-dialog")).toContainText("Mafia");
    for (const p of [alice!, bob!, carol!, dave!, erin!]) await waitForRoleRevealToClose(p);

    // Night 1: Alice (sole mafia) kills Bob; Carol protects Dave; Dave
    // investigates Alice; Bob & Erin file decoys.
    await submitAndLockMafiaTarget(alice!, "Bob");
    await submitAndConfirmNightTarget(carol!, "Dave");
    await submitAndConfirmNightTarget(dave!, "Alice");
    await settleWatch(bob!, "Alice");
    await settleWatch(erin!, "Alice");

    // scenePhases ON: the ready night parks in SUNRISE, unresolved. Every
    // player sees the neutral holding screen — NOT dawn, NOT a god view.
    await waitForPhase(alice!, "sunrise", 25_000);
    for (const p of [alice!, bob!, carol!, dave!, erin!]) {
      await waitForPhase(p, "sunrise", 25_000);
      await expect(p.getByTestId("scene-holding")).toBeVisible();
    }

    // LEAK PROOF: the victim (Bob) sees no death/outcome hint anywhere in his
    // holding screen — no "died", no "found dead", no name-drop of an outcome.
    const bobHtml = await bob!.locator("#root").innerHTML();
    expect(bobHtml).not.toContain("found dead");
    expect(bobHtml).not.toContain("died");
    // Bob's own game-status panel still shows him alive (5 of 5), empty grave.
    await bob!.getByTestId("game-status-button").click();
    await expect(bob!.getByTestId("graveyard")).toContainText("no casualties");
    await bob!.getByTestId("game-status-close").click();

    // The host sees the Reveal button (only in sunrise/sunset).
    await expect(hostPage.getByTestId("reveal-button")).toBeVisible();
    await hostPage.getByTestId("reveal-button").click();

    // NOW the night resolves -> dawn; players see the morning report naming
    // the victim (the outcome that was withheld until reveal).
    await waitForPhase(alice!, "dawn", 25_000);
    await expect(alice!.getByTestId("morning-report")).toBeVisible();
    await expect(alice!.getByTestId("interstitial-lines")).toContainText("Bob");

    // The reveal button is gone once out of the scene phase.
    await expect(hostPage.getByTestId("reveal-button")).toHaveCount(0);

    // Bob is dead now (the death the holding screen withheld). His game-status
    // graveyard reflects it, and — crucially — it did NOT show before reveal.
    // Read it from the dead player's own view without racing the ack beat.
    await bob!.getByTestId("game-status-button").click();
    await expect(bob!.getByTestId("graveyard")).toContainText("Bob");
    await bob!.getByTestId("game-status-close").click();

    await hostCtx.close();
    for (const c of ctxs) await c.close();
  });
});

test.describe("Spec 12: all-player game status (graveyard + roles remaining)", () => {
  test("a living player can open the status panel mid-game and see aggregate counts + graveyard", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const ctxs = await Promise.all([0, 1, 2, 3, 4].map(() => browser.newContext()));
    const hostPage = await hostCtx.newPage();
    const roomCode = await createRoomAsHost(hostPage);
    const [alice, bob, carol, dave, erin] = await Promise.all(ctxs.map((c) => c.newPage()));

    await joinAsPlayer(alice!, roomCode, "Alice");
    await joinAsPlayer(bob!, roomCode, "Bob");
    await joinAsPlayer(carol!, roomCode, "Carol");
    await joinAsPlayer(dave!, roomCode, "Dave");
    await joinAsPlayer(erin!, roomCode, "Erin");

    // No scene phases here — plain game (testRoles empty -> HOUSE mix: seed 42
    // = Alice:detective, Bob:mafia, Carol:bomber, Dave:angel, Erin:mafia).
    await hostPage.evaluate(() => {
      sessionStorage.setItem("mafia:testSeed", "42");
      sessionStorage.setItem("mafia:testRoles", "{}");
    });
    await hostPage.getByTestId("start-game").click();

    await waitForPhase(alice!, "night");
    for (const p of [alice!, bob!, carol!, dave!, erin!]) await waitForRoleRevealToClose(p);

    // Open the status panel mid-night as a living player. Aggregate role counts
    // are ALWAYS shown in full (Tanner's transparency choice). 5 alive / 5 total.
    await alice!.getByTestId("game-status-button").click();
    await expect(alice!.getByTestId("game-status-panel")).toBeVisible();
    await expect(alice!.getByTestId("game-status-panel")).toContainText("5 of 5");
    await expect(alice!.getByTestId("roles-remaining")).toContainText("Mafia");
    // The mafia count row shows 2 (HOUSE mix for 5 players).
    await expect(
      alice!.getByTestId("roles-remaining-row").filter({ hasText: "Mafia" }),
    ).toContainText("2");
    await expect(alice!.getByTestId("graveyard")).toContainText("no casualties");

    // LEAK CHECK: the panel exposes only aggregate COUNTS, never a per-living-
    // player role row. The panel HTML must not name a living player against a
    // role. It lists role names + counts only (roles-remaining) and the
    // graveyard (empty here) — no living player names appear at all.
    const panelHtml = await alice!.getByTestId("game-status-panel").innerHTML();
    for (const name of ["Alice", "Bob", "Carol", "Dave", "Erin"]) {
      expect(panelHtml).not.toContain(name);
    }
    await alice!.getByTestId("game-status-close").click();

    await hostCtx.close();
    for (const c of ctxs) await c.close();
  });
});

test.describe("Spec 12: host narrator board", () => {
  test("the board shows locked picks and who hasn't locked, for night and day", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const ctxs = await Promise.all([0, 1, 2, 3, 4].map(() => browser.newContext()));
    const hostPage = await hostCtx.newPage();
    const roomCode = await createRoomAsHost(hostPage);
    const [alice, bob, carol, dave, erin] = await Promise.all(ctxs.map((c) => c.newPage()));

    await joinAsPlayer(alice!, roomCode, "Alice");
    await joinAsPlayer(bob!, roomCode, "Bob");
    await joinAsPlayer(carol!, roomCode, "Carol");
    await joinAsPlayer(dave!, roomCode, "Dave");
    await joinAsPlayer(erin!, roomCode, "Erin");

    // HOUSE mix seed 42: Alice:detective, Bob:mafia, Carol:bomber, Dave:angel,
    // Erin:mafia.
    await hostPage.evaluate(() => {
      sessionStorage.setItem("mafia:testSeed", "42");
      sessionStorage.setItem("mafia:testRoles", "{}");
    });
    await hostPage.getByTestId("start-game").click();

    await waitForPhase(alice!, "night");
    for (const p of [alice!, bob!, carol!, dave!, erin!]) await waitForRoleRevealToClose(p);

    // The host board exists from the start (host-only, god view).
    await expect(hostPage.getByTestId("narrator-vote-board")).toBeVisible();
    await expect(hostPage.getByTestId("board-phase-nav")).toBeVisible();

    // Bob (mafia) locks a kill on Carol -> the board shows a locked night row
    // for Bob's kill; the others still haven't locked (stragglers listed).
    await submitAndLockMafiaTarget(bob!, "Carol");
    await expect(
      hostPage.getByTestId("board-night-row").filter({ hasText: "kill → Carol" }).first(),
    ).toBeVisible();
    await expect(hostPage.getByTestId("board-night-stragglers")).toContainText("Alice");

    // Finish the night as a clean angel save so the 2-mafia immediate-parity
    // game doesn't end here: Erin also targets Carol, but Dave (angel) protects
    // Carol -> the attack fails, nobody dies -> day. Alice investigates Bob;
    // Carol files a decoy.
    await submitAndLockMafiaTarget(erin!, "Carol");
    await submitAndConfirmNightTarget(dave!, "Carol");
    await submitAndConfirmNightTarget(alice!, "Bob");
    await settleWatch(carol!, "Alice");

    await waitForPhase(alice!, "dawn", 25_000);
    for (const p of [alice!, bob!, carol!, dave!, erin!]) await acknowledgeMorning(p);
    await waitForPhase(alice!, "day", 25_000);

    // Day: Alice locks a vote on Bob -> the board's day-vote section shows it,
    // and lists who hasn't locked. Night 1 and day 1 share the same day number,
    // so the board still shows the reconstructed night rows alongside the votes
    // (proof the history survives state being cleared each phase).
    await alice!.getByTestId("vote-option").filter({ hasText: "Bob" }).click();
    await alice!.getByTestId("confirm-vote-button").click();
    await expect(hostPage.getByTestId("board-vote-row").filter({ hasText: "Alice" })).toBeVisible();
    await expect(hostPage.getByTestId("board-day-stragglers")).toBeVisible();
    // The night's locked kill row is still reconstructable from the log even
    // though state.mafiaVotes was cleared at resolution.
    await expect(
      hostPage.getByTestId("board-night-row").filter({ hasText: "kill → Carol" }).first(),
    ).toBeVisible();
    await expect(hostPage.getByTestId("board-phase-nav")).toBeVisible();

    await hostCtx.close();
    for (const c of ctxs) await c.close();
  });
});
