import { expect, test, type Page } from "@playwright/test";

// Component-level checks (Spec 04, D4): HoldToPeek (role visible only while
// pressed, plus the keyboard/AT timed-reveal fallback), vote-change
// re-render (current-vote highlight moves, no confirm-lock), hidden-mode
// tally shows counts not names. Driven through the real app (no separate
// component-test runner in the dependency budget) against a single seeded
// game so these don't need their own full 5-context setup beyond what's
// needed to reach the relevant screen.

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

async function startGameWithSeedAndRoles(
  hostPage: Page,
  seed: number,
  roles: Record<string, number>,
) {
  await hostPage.evaluate(
    ({ s, r }) => {
      sessionStorage.setItem("mafia:testSeed", String(s));
      sessionStorage.setItem("mafia:testRoles", JSON.stringify(r));
    },
    { s: seed, r: roles },
  );
  await hostPage.getByTestId("start-game").click();
}

async function waitForPhase(page: Page, phase: string, timeout = 25_000) {
  await expect(page.getByTestId("game-screen")).toHaveAttribute(
    "data-phase",
    phase,
    {
      timeout,
    },
  );
}

// RoleReveal (Radix Dialog) auto-dismisses 5s after assignment; its overlay
// sits above the night-action drawer and intercepts pointer events until it
// actually closes. A real player waits this out before acting.
async function waitForRoleRevealToClose(page: Page) {
  await expect(page.getByTestId("role-reveal-dialog")).toHaveCount(0, {
    timeout: 15_000,
  });
}

async function setUpFivePlayerGame(
  browser: import("@playwright/test").Browser,
  seed: number,
  roles?: Record<string, number>,
) {
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
  if (roles) {
    await startGameWithSeedAndRoles(hostPage, seed, roles);
  } else {
    await startGameWithSeed(hostPage, seed);
  }
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

// Seed 42 -> Alice:detective, Bob:mafia, Carol:suicide_bomber, Dave:angel,
// Erin:mafia (verified against startGame; same mapping as game.spec.ts's
// scenario A).

test("HoldToPeek: role is visible only while the affordance is actively pressed", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");

  // The role-reveal Dialog auto-dismisses after 5s; wait it out so the
  // HoldToPeek affordance (not the dialog) is what's under test.
  await expect(game.alice.getByTestId("role-reveal-dialog")).toHaveCount(0, {
    timeout: 15_000,
  });

  const peek = game.alice.getByTestId("hold-to-peek");
  const content = game.alice.getByTestId("hold-to-peek-content");

  await expect(content).toHaveAttribute("data-revealed", "false");

  // Pointer down reveals; pointer up hides again instantly.
  const box = await peek.boundingBox();
  if (!box) throw new Error("hold-to-peek not rendered");
  await game.alice.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await game.alice.mouse.down();
  await expect(content).toHaveAttribute("data-revealed", "true");
  await expect(content).toContainText("Detective");

  await game.alice.mouse.up();
  await expect(content).toHaveAttribute("data-revealed", "false");

  await game.closeAll();
});

test("HoldToPeek: keyboard activation gives a timed reveal with an aria-live announcement", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  await expect(game.alice.getByTestId("role-reveal-dialog")).toHaveCount(0, {
    timeout: 15_000,
  });

  const peek = game.alice.getByTestId("hold-to-peek");
  const content = game.alice.getByTestId("hold-to-peek-content");
  const live = game.alice.getByTestId("hold-to-peek-live");

  await peek.focus();
  await peek.press("Enter");

  await expect(content).toHaveAttribute("data-revealed", "true");
  await expect(live).toContainText("revealed");

  // Timed reveal (3s) hides itself without any further interaction.
  await expect(content).toHaveAttribute("data-revealed", "false", {
    timeout: 5_000,
  });
  await expect(live).toContainText("hidden");

  await game.closeAll();
});

test("vote change re-renders the current-vote highlight, no confirm-lock", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await waitForRoleRevealToClose(p);
  }

  // Fast-forward through night 1 with a harmless script so we reach day 1's
  // voting screen (this test is about vote UI, not the night script).
  await game.bob
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.erin
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.dave
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.alice
    .getByTestId("night-target-option")
    .filter({ hasText: "Bob" })
    .click();
  // Spec 08: the mafia team (Bob, Erin) must lock in their agreed target
  // before the night can resolve — submitting alone is only tentative.
  await expect(game.bob.getByTestId("lock-in-button")).toBeEnabled();
  await game.bob.getByTestId("lock-in-button").click();
  await expect(game.erin.getByTestId("lock-in-button")).toBeEnabled();
  await game.erin.getByTestId("lock-in-button").click();

  await waitForPhase(game.alice, "dawn", 25_000);
  await waitForPhase(game.alice, "day", 25_000);

  const bobOption = game.alice
    .getByTestId("vote-option")
    .filter({ hasText: "Bob" });
  const carolOption = game.alice
    .getByTestId("vote-option")
    .filter({ hasText: "Carol" });

  await bobOption.click();
  await expect(bobOption).toHaveAttribute("data-voted", "true");
  await expect(carolOption).toHaveAttribute("data-voted", "false");

  // Changing the vote moves the highlight -- no confirm dialog, no lock.
  await carolOption.click();
  await expect(carolOption).toHaveAttribute("data-voted", "true");
  await expect(bobOption).toHaveAttribute("data-voted", "false");

  await game.closeAll();
});

test("hidden-mode tally shows counts, never names", async ({ browser }) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await waitForRoleRevealToClose(p);
  }

  await game.bob
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.erin
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.dave
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.alice
    .getByTestId("night-target-option")
    .filter({ hasText: "Bob" })
    .click();
  // Spec 08: the mafia team (Bob, Erin) must lock in their agreed target
  // before the night can resolve — submitting alone is only tentative.
  await expect(game.bob.getByTestId("lock-in-button")).toBeEnabled();
  await game.bob.getByTestId("lock-in-button").click();
  await expect(game.erin.getByTestId("lock-in-button")).toBeEnabled();
  await game.erin.getByTestId("lock-in-button").click();

  await waitForPhase(game.alice, "dawn", 25_000);
  await waitForPhase(game.alice, "day", 25_000);

  // House rules default to hidden voting visibility -- the tally must read
  // "N of M have voted" and never render another player's chosen target.
  await expect(game.alice.getByTestId("vote-tally")).toHaveAttribute(
    "data-mode",
    "hidden",
  );
  await expect(game.alice.getByTestId("vote-tally")).toContainText(
    "of 5 have voted",
  );

  await game.bob
    .getByTestId("vote-option")
    .filter({ hasText: "Carol" })
    .click();
  await expect(game.alice.getByTestId("vote-tally")).toContainText(
    "1 of 5 have voted",
  );

  await game.dave
    .getByTestId("vote-option")
    .filter({ hasText: "Carol" })
    .click();
  await expect(game.alice.getByTestId("vote-tally")).toContainText(
    "2 of 5 have voted",
  );

  // No per-candidate vote counts render in hidden mode.
  await expect(
    game.alice.getByTestId("vote-option").filter({ hasText: "Carol" }),
  ).not.toContainText(/\d/);

  await game.closeAll();
});

// Seed 1 with a role override ({mafia:1, villager:1, minion:1,
// suicide_bomber:0}, detective/angel:1 kept from the house-rules base) ->
// Alice:minion, Bob:detective, Carol:villager, Dave:mafia, Erin:angel
// (verified against startGame with this exact roles object, summing to 5).
// `minion: 0` is hardcoded in the real `HOUSE_RULESET` the client sends, so
// `mafia:testRoles` — a test-only sessionStorage hook mirroring
// `mafia:testSeed`'s gating — is required to reach a minion viewer at all
// through the real app.
test("you.mafiaRoster (Spec 02 v2.6): a minion context renders the mafia's name, a villager context never does", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 1, {
    mafia: 1,
    villager: 1,
    minion: 1,
    suicide_bomber: 0,
  });
  await waitForPhase(game.alice, "night");
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await waitForRoleRevealToClose(p);
  }

  // Alice (minion): no night action, but the roster IS the role's ability.
  await expect(game.alice.getByTestId("minion-idle")).toBeVisible();
  await expect(game.alice.getByTestId("mafia-roster")).toContainText("Dave");

  // Carol (villager): idle "town sleeps" state, no roster ever rendered —
  // the projection carries no `you.mafiaRoster` key for her at all.
  await expect(game.carol.getByTestId("night-idle")).toBeVisible();
  await expect(game.carol.getByTestId("mafia-roster")).toHaveCount(0);
  await expect(game.carol.locator("body")).not.toContainText("Dave");

  // Advance to day so the day-view roster rendering path is covered too.
  // Dave (sole mafia killer) targets Bob, but Erin (angel) protects Bob the
  // same night -- nobody dies, so the game continues past dawn instead of
  // resolving parity (killing the lone villager here would immediately end
  // the game, since mafia+minion would already equal the remaining town).
  await game.dave
    .getByTestId("night-target-option")
    .filter({ hasText: "Bob" })
    .click();
  // Spec 08: Dave is the sole mafia killer here — he must lock in before
  // the night can resolve naturally.
  await expect(game.dave.getByTestId("lock-in-button")).toBeEnabled();
  await game.dave.getByTestId("lock-in-button").click();
  await game.bob
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.erin
    .getByTestId("night-target-option")
    .filter({ hasText: "Bob" })
    .click();

  await waitForPhase(game.alice, "dawn", 25_000);
  await waitForPhase(game.alice, "day", 25_000);

  await expect(game.alice.getByTestId("mafia-roster")).toContainText("Dave");
  await expect(game.carol.getByTestId("mafia-roster")).toHaveCount(0);

  await game.closeAll();
});

test("you.currentVote (Spec 02 v2.6): a hard reload mid-vote restores the current-vote highlight from the projection", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await waitForRoleRevealToClose(p);
  }

  await game.bob
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.erin
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.dave
    .getByTestId("night-target-option")
    .filter({ hasText: "Carol" })
    .click();
  await game.alice
    .getByTestId("night-target-option")
    .filter({ hasText: "Bob" })
    .click();
  // Spec 08: the mafia team (Bob, Erin) must lock in their agreed target
  // before the night can resolve — submitting alone is only tentative.
  await expect(game.bob.getByTestId("lock-in-button")).toBeEnabled();
  await game.bob.getByTestId("lock-in-button").click();
  await expect(game.erin.getByTestId("lock-in-button")).toBeEnabled();
  await game.erin.getByTestId("lock-in-button").click();

  await waitForPhase(game.alice, "dawn", 25_000);
  await waitForPhase(game.alice, "day", 25_000);

  const bobOption = game.alice
    .getByTestId("vote-option")
    .filter({ hasText: "Bob" });
  await bobOption.click();
  await expect(bobOption).toHaveAttribute("data-voted", "true");

  // A genuine page reload remounts DayVoting, discarding any component-local
  // state -- the highlight must be restored from `you.currentVote` in the
  // freshly-hydrated snapshot, not lost until the voter re-clicks.
  await game.alice.reload();
  await waitForPhase(game.alice, "day", 25_000);
  await expect(
    game.alice.getByTestId("vote-option").filter({ hasText: "Bob" }),
  ).toHaveAttribute("data-voted", "true");

  await game.closeAll();
});
