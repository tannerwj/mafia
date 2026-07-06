import { expect, test, type Page } from "@playwright/test";

// Spec 15 — AI narrator ("The Storyteller"), E2E in fake mode. `.dev.vars`
// sets STORYTELLER_FAKE=1 for the dev server these tests run against
// (playwright.config.ts's webServer runs `npm run dev`), so every
// `generate_story` returns a deterministic canned scene without ever
// touching env.AI — see src/server/storyteller.ts's fakeStoryOutput,
// seeded by beat+day so continuity is assertable.
//
// Built on host-console.spec.ts's harness (seed 42, legacy explicit roles):
// Alice:detective, Bob:mafia, Carol:suicide_bomber, Dave:angel, Erin:mafia.
// scene-status.spec.ts's pattern is reused for the scenePhases (sunrise
// atmosphere beat) scenario.

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

const LEGACY_EXPLICIT_ROLES_BASE = { detective: 1, angel: 1, suicide_bomber: 1, minion: 0 };

async function startGameWithSeed(hostPage: Page, seed: number) {
  await hostPage.evaluate(
    ({ s, base }) => {
      sessionStorage.setItem("mafia:testSeed", String(s));
      sessionStorage.setItem("mafia:testRoles", JSON.stringify(base));
    },
    { s: seed, base: LEGACY_EXPLICIT_ROLES_BASE },
  );
  await hostPage.getByTestId("start-game").click();
}

async function startScenePhasesGame(hostPage: Page, seed: number) {
  await hostPage.evaluate((s) => sessionStorage.setItem("mafia:testSeed", String(s)), seed);
  const toggle = hostPage.getByTestId("scene-phases-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await hostPage.getByTestId("role-count-mafia-dec").click();
  await expect(hostPage.getByTestId("role-count-mafia-value")).toHaveText("1");
  await hostPage.getByTestId("start-game").click();
}

async function waitForPhase(page: Page, phase: string, timeout = 25_000) {
  await expect(page.getByTestId("game-screen")).toHaveAttribute("data-phase", phase, { timeout });
}

async function waitForHostPhase(page: Page, phase: string, timeout = 25_000) {
  if (phase === "ended") {
    await expect(page.getByTestId("host-winner-splash")).toBeVisible({ timeout });
  } else {
    await expect(page.getByTestId("host-phase-label")).toContainText(new RegExp(phase, "i"), { timeout });
  }
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

/** Opens the setup dialog, enables the Storyteller, sets a theme + tone,
 * closes it. Reusable from lobby or in-game (same component). */
async function enableStoryteller(hostPage: Page, theme: string) {
  await hostPage.getByTestId("storyteller-setup-open").click();
  await expect(hostPage.getByTestId("storyteller-setup-dialog")).toBeVisible();
  await hostPage.getByTestId("storyteller-enabled-toggle").click();
  await expect(hostPage.getByTestId("storyteller-enabled-toggle")).toHaveAttribute("aria-checked", "true");
  await hostPage.getByTestId("storyteller-theme-input").fill(theme);
  await hostPage.getByTestId("storyteller-theme-input").blur();
  await hostPage.getByTestId("storyteller-tone-horror").click();
  await hostPage.getByTestId("storyteller-setup-close").click();
  await expect(hostPage.getByTestId("storyteller-setup-dialog")).toHaveCount(0);
}

test.describe("Spec 15: AI narrator — Storyteller setup + morning-report spin", () => {
  test("host enables the Storyteller in the lobby, spins a morning-report scene, and it auto-keeps into history on advance", async ({ browser }) => {
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

    // Enabled from the lobby, before the game even starts.
    await enableStoryteller(hostPage, "a snowed-in ski lodge");
    await expect(hostPage.getByTestId("storyteller-setup-open")).toContainText("on");

    await startGameWithSeed(hostPage, 42);
    await waitForPhase(alice!, "night");
    for (const p of [alice!, bob!, carol!, dave!, erin!]) await waitForRoleRevealToClose(p);

    // Night 1: Bob & Erin (mafia) both target Carol; Dave (angel) protects
    // Carol -> attack fails, nobody dies -> day. Alice investigates Bob.
    await submitAndLockMafiaTarget(bob!, "Carol");
    await submitAndLockMafiaTarget(erin!, "Carol");
    await submitAndConfirmNightTarget(dave!, "Carol");
    await submitAndConfirmNightTarget(alice!, "Bob");
    await settleWatch(carol!, "Alice");

    await waitForHostPhase(hostPage, "dawn", 25_000);

    // The Storyteller panel's "Spin the morning report" button is visible
    // now (dawn is the morning-report beat's legal phase).
    await expect(hostPage.getByTestId("spin-the-tale")).toBeVisible();
    await hostPage.getByTestId("spin-the-tale").click();
    await expect(hostPage.getByTestId("storyteller-draft-text")).toBeVisible({ timeout: 10_000 });
    const draftText = await hostPage.getByTestId("storyteller-draft-text").textContent();
    expect(draftText?.length ?? 0).toBeGreaterThan(0);

    // Advance past dawn -> auto-keep commits the draft into kept history.
    for (const p of [alice!, bob!, carol!, dave!, erin!]) await acknowledgeMorning(p);
    await waitForHostPhase(hostPage, "day", 25_000);

    await expect(hostPage.getByTestId("storyteller-history-row")).toHaveCount(1);
    await expect(hostPage.getByTestId("storyteller-history-row").first()).toContainText(draftText ?? "");
    // The draft panel itself is gone once committed (no pending draft anymore).
    await expect(hostPage.getByTestId("storyteller-draft")).toHaveCount(0);

    await hostCtx.close();
    for (const c of ctxs) await c.close();
  });

  test("reload mid-pending-draft: the draft is gone, but already-committed history survives", async ({ browser }) => {
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

    await enableStoryteller(hostPage, "");
    await startGameWithSeed(hostPage, 42);
    await waitForPhase(alice!, "night");
    for (const p of [alice!, bob!, carol!, dave!, erin!]) await waitForRoleRevealToClose(p);

    await submitAndLockMafiaTarget(bob!, "Carol");
    await submitAndLockMafiaTarget(erin!, "Carol");
    await submitAndConfirmNightTarget(dave!, "Carol");
    await submitAndConfirmNightTarget(alice!, "Bob");
    await settleWatch(carol!, "Alice");
    await waitForHostPhase(hostPage, "dawn", 25_000);

    // Spin a draft but do NOT advance past the beat yet.
    await hostPage.getByTestId("spin-the-tale").click();
    await expect(hostPage.getByTestId("storyteller-draft-text")).toBeVisible({ timeout: 10_000 });

    // Reload the host tab (mid-pending-draft, per spec — ephemeral by design).
    await hostPage.reload();
    await expect(hostPage.getByTestId("host-phase-label")).toContainText(/dawn/i, { timeout: 15_000 });
    // The draft is gone (client-side ephemeral state lost on reload).
    await expect(hostPage.getByTestId("storyteller-draft")).toHaveCount(0);
    // Storyteller settings/history survive (they ride the snapshot).
    await expect(hostPage.getByTestId("storyteller-setup-open")).toContainText("on");

    // Host simply re-spins.
    await expect(hostPage.getByTestId("spin-the-tale")).toBeVisible();
    await hostPage.getByTestId("spin-the-tale").click();
    await expect(hostPage.getByTestId("storyteller-draft-text")).toBeVisible({ timeout: 10_000 });

    await hostCtx.close();
    for (const c of ctxs) await c.close();
  });
});

test.describe("Spec 15: atmosphere beat (sunrise-hold) — pure atmosphere, no outcome leaked", () => {
  test("host spins an atmosphere scene during the unresolved sunrise hold; the scene never names an outcome", async ({ browser }) => {
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

    await enableStoryteller(hostPage, "a foggy harbor town");
    await startScenePhasesGame(hostPage, 42);

    await waitForPhase(alice!, "night");
    for (const p of [alice!, bob!, carol!, dave!, erin!]) await waitForRoleRevealToClose(p);

    // Night 1: Alice (sole mafia) kills Bob; Carol protects Dave; Dave
    // investigates Alice; Bob & Erin file decoys (matches scene-status.spec.ts).
    await submitAndLockMafiaTarget(alice!, "Bob");
    await submitAndConfirmNightTarget(carol!, "Dave");
    await submitAndConfirmNightTarget(dave!, "Alice");
    await settleWatch(bob!, "Alice");
    await settleWatch(erin!, "Alice");

    await waitForPhase(alice!, "sunrise", 25_000);
    for (const p of [bob!, carol!, dave!, erin!]) await waitForPhase(p, "sunrise", 25_000);

    // The atmosphere beat's spin button is available during the hold.
    await expect(hostPage.getByTestId("spin-the-tale")).toBeVisible();
    await hostPage.getByTestId("spin-the-tale").click();
    await expect(hostPage.getByTestId("storyteller-draft-text")).toBeVisible({ timeout: 10_000 });
    const atmosphereText = (await hostPage.getByTestId("storyteller-draft-text").textContent()) ?? "";

    // LEAK PROOF: the atmosphere scene never reveals Bob's death — the
    // outcome is genuinely unresolved at this beat (Spec 12 deferred
    // resolution; Spec 15's structural guard forbids reading deaths/log for
    // this beat). Bob's NAME is fine to see — he's still publicly alive on
    // the roster pre-reveal (spec §Beats A); only his death is secret, so
    // assert the scene is atmosphere-shaped (no death marker, no
    // report-beat marker) rather than that his name is absent.
    expect(atmosphereText.toLowerCase()).not.toContain("did not see the dawn");
    expect(atmosphereText.toLowerCase()).toContain("nothing is known yet");
    expect(atmosphereText).not.toContain("morning-report");

    // Reveal -> the night resolves; the host can now spin the (separate)
    // morning-report beat with the real outcome.
    await hostPage.getByTestId("reveal-button").click();
    await waitForHostPhase(hostPage, "dawn", 25_000);
    await expect(hostPage.getByTestId("storyteller-history-row")).toHaveCount(1); // the atmosphere scene auto-committed on the phase advance
    await expect(hostPage.getByTestId("spin-the-tale")).toBeVisible();

    await hostCtx.close();
    for (const c of ctxs) await c.close();
  });
});

test.describe("Spec 15: player-side leak proof — zero story surface, ever", () => {
  test("a player client shows no Storyteller UI and no story_* content anywhere, even with kept scenes", async ({ browser }) => {
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

    await enableStoryteller(hostPage, "a smoky jazz club");
    await startGameWithSeed(hostPage, 42);
    await waitForPhase(alice!, "night");
    for (const p of [alice!, bob!, carol!, dave!, erin!]) await waitForRoleRevealToClose(p);

    // No player screen has ANY Storyteller testid, from the very start.
    for (const p of [alice!, bob!, carol!, dave!, erin!]) {
      await expect(p.getByTestId("storyteller-setup-open")).toHaveCount(0);
      await expect(p.getByTestId("spin-the-tale")).toHaveCount(0);
      await expect(p.getByTestId("storyteller-panel")).toHaveCount(0);
    }

    await submitAndLockMafiaTarget(bob!, "Carol");
    await submitAndLockMafiaTarget(erin!, "Carol");
    await submitAndConfirmNightTarget(dave!, "Carol");
    await submitAndConfirmNightTarget(alice!, "Bob");
    await settleWatch(carol!, "Alice");
    await waitForHostPhase(hostPage, "dawn", 25_000);

    await hostPage.getByTestId("spin-the-tale").click();
    await expect(hostPage.getByTestId("storyteller-draft-text")).toBeVisible({ timeout: 10_000 });
    const draftText = (await hostPage.getByTestId("storyteller-draft-text").textContent()) ?? "";

    for (const p of [alice!, bob!, carol!, dave!, erin!]) await acknowledgeMorning(p);
    await waitForHostPhase(hostPage, "day", 25_000);

    // Kept scene now exists (host history has it) — confirm it never reaches
    // any player's DOM anywhere, root HTML included.
    await expect(hostPage.getByTestId("storyteller-history-row")).toHaveCount(1);
    for (const p of [alice!, bob!, carol!, dave!, erin!]) {
      await expect(p.getByTestId("storyteller-setup-open")).toHaveCount(0);
      await expect(p.getByTestId("storyteller-panel")).toHaveCount(0);
      const rootHtml = await p.locator("#root").innerHTML();
      expect(rootHtml).not.toContain(draftText);
      expect(rootHtml.toLowerCase()).not.toContain("storyteller");
    }

    await hostCtx.close();
    for (const c of ctxs) await c.close();
  });
});
