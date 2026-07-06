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

// Spec 13: `HOUSE_RULESET.roles` is now all-"auto" for the house six, so an
// empty (or partial) `mafia:testRoles` override no longer reproduces the
// pre-Spec-13 explicit shape — `materializeRoleCounts` inserts auto-resolved
// keys in declaration order, which shifted (mafia now resolves first, ahead
// of detective/angel/suicide_bomber/minion) and that insertion order feeds
// `Object.entries(counts)` BEFORE the seeded shuffle in `machine.ts`, so
// seed->assignment mappings silently changed. This legacy base pins the
// pre-Spec-13 explicit shape (detective/angel/suicide_bomber/minion fixed,
// mafia/villager auto) so `materializeRoleCounts`'s insertion order — and
// therefore every seeded role map documented in this file — stays byte-stable.
const LEGACY_EXPLICIT_ROLES_BASE = { detective: 1, angel: 1, suicide_bomber: 1, minion: 0 };

async function startGameWithSeed(hostPage: Page, seed: number) {
  await hostPage.evaluate(
    ({ s, base }) => {
      sessionStorage.setItem("mafia:testSeed", String(s));
      // Spec 11/13: the legacy explicit shape -> Room sends the pre-Spec-13
      // HOUSE_RULESET wire shape (not the new all-auto default), preserving
      // the seed->assignment mapping.
      sessionStorage.setItem("mafia:testRoles", JSON.stringify(base));
    },
    { s: seed, base: LEGACY_EXPLICIT_ROLES_BASE },
  );
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
    { s: seed, r: { ...LEGACY_EXPLICIT_ROLES_BASE, ...roles } },
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

// Spec 11: confirm an individual night pick (detective/angel) via the shared
// night-confirm button.
async function confirmNight(page: Page, targetName: string) {
  await page.getByTestId("night-target-option").filter({ hasText: targetName }).click();
  const confirm = page.getByTestId("night-confirm-button");
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

// Spec 11: a no-action role files the inert decoy "watch" pick + confirm.
async function settleWatch(page: Page, targetName: string) {
  const option = page.getByTestId("night-watch-option").filter({ hasText: targetName });
  await expect(option.first()).toBeVisible();
  await option.first().click();
  const confirm = page.getByTestId("night-confirm-button");
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

// Spec 11: dawn Morning Report acknowledge (living players only).
async function acknowledgeMorning(page: Page) {
  const button = page.getByTestId("acknowledge-button");
  if (await button.isVisible().catch(() => false)) await button.click();
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

test("vote change re-renders the current-vote highlight; confirm then reconsider", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await waitForRoleRevealToClose(p);
  }

  // Fast-forward through night 1 so we reach day 1's voting screen (this test
  // is about vote UI, not the night script). Spec 11: EVERY living player
  // picks + confirms — the two mafia lock, angel/detective confirm, and the
  // bomber (Carol) files a decoy watch.
  await game.bob.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await game.erin.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.bob.getByTestId("lock-in-button")).toBeEnabled();
  await game.bob.getByTestId("lock-in-button").click();
  await expect(game.erin.getByTestId("lock-in-button")).toBeEnabled();
  await game.erin.getByTestId("lock-in-button").click();
  await confirmNight(game.dave, "Carol");
  await confirmNight(game.alice, "Bob");
  await settleWatch(game.carol, "Alice");

  await waitForPhase(game.alice, "dawn", 25_000);
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await acknowledgeMorning(p);
  }
  await waitForPhase(game.alice, "day", 25_000);

  const bobOption = game.alice.getByTestId("vote-option").filter({ hasText: "Bob" });
  const carolOption = game.alice.getByTestId("vote-option").filter({ hasText: "Carol" });

  // Selecting is tentative (data-voted true, data-locked false) — freely
  // changeable until confirmed.
  await bobOption.click();
  await expect(bobOption).toHaveAttribute("data-voted", "true");
  await expect(bobOption).toHaveAttribute("data-locked", "false");
  await expect(carolOption).toHaveAttribute("data-voted", "false");

  await carolOption.click();
  await expect(carolOption).toHaveAttribute("data-voted", "true");
  await expect(bobOption).toHaveAttribute("data-voted", "false");

  // Confirm locks the pick (Spec 11 select->confirm) — options become
  // disabled and the locked-state card appears; Reconsider re-opens it.
  await game.alice.getByTestId("confirm-vote-button").click();
  await expect(game.alice.getByTestId("vote-locked-state")).toBeVisible();
  await expect(carolOption).toHaveAttribute("data-locked", "true");
  await game.alice.getByTestId("unconfirm-vote-button").click();
  await expect(game.alice.getByTestId("confirm-vote-button")).toBeVisible();
  await expect(carolOption).toHaveAttribute("data-locked", "false");

  await game.closeAll();
});

test("hidden-mode tally: no denominator, no per-candidate counts, no other players' targets", async ({
  browser,
}) => {
  const game = await setUpFivePlayerGame(browser, 42);
  await waitForPhase(game.alice, "night");
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await waitForRoleRevealToClose(p);
  }

  await game.bob.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await game.erin.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.bob.getByTestId("lock-in-button")).toBeEnabled();
  await game.bob.getByTestId("lock-in-button").click();
  await expect(game.erin.getByTestId("lock-in-button")).toBeEnabled();
  await game.erin.getByTestId("lock-in-button").click();
  await confirmNight(game.dave, "Carol");
  await confirmNight(game.alice, "Bob");
  await settleWatch(game.carol, "Alice");

  await waitForPhase(game.alice, "dawn", 25_000);
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await acknowledgeMorning(p);
  }
  await waitForPhase(game.alice, "day", 25_000);

  // Spec 11 no-pending-count leak ban: hidden voting shows a "sealed ballots"
  // message — NEVER a "N of M have voted" denominator (a per-seat signal in
  // disguise), and never another player's chosen target.
  await expect(game.alice.getByTestId("vote-tally")).toHaveAttribute("data-mode", "hidden");
  await expect(game.alice.getByTestId("vote-tally")).not.toContainText(/of \d+ have/i);
  await expect(game.alice.getByTestId("vote-tally")).not.toContainText(/\d/);

  // Other players voting must not change what Alice sees (no live count).
  await game.bob.getByTestId("vote-option").filter({ hasText: "Carol" }).click();
  await game.dave.getByTestId("vote-option").filter({ hasText: "Carol" }).click();
  await expect(game.alice.getByTestId("vote-tally")).not.toContainText(/\d/);

  // No per-candidate vote counts render in hidden mode.
  await expect(
    game.alice.getByTestId("vote-option").filter({ hasText: "Carol" }),
  ).not.toContainText(/\d/);

  await game.closeAll();
});

// Seed 1 with a role override ({mafia:1, villager:1, minion:1,
// suicide_bomber:0} merged onto LEGACY_EXPLICIT_ROLES_BASE's detective:1/
// angel:1) -> Alice:minion, Bob:detective, Carol:villager, Dave:mafia,
// Erin:angel (verified against startGame with this exact roles object,
// summing to 5). Spec 13's live pre-fill only reaches 1 minion at 16+
// players, so `mafia:testRoles` — a test-only sessionStorage hook mirroring
// `mafia:testSeed`'s gating — is required to reach a minion viewer at all
// through the real app at this table size.
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

  // Spec 11: the minion no longer sits idle — they file the same decoy watch
  // as everyone else (killing the "only power roles tap" tell). The roster IS
  // still their knowledge grant, rendered in the same drawer.
  await expect(game.alice.getByTestId("night-watch-option").first()).toBeVisible();
  await expect(game.alice.getByTestId("mafia-roster")).toContainText("Dave");

  // Carol (villager): also the decoy watch picker, but NO roster (the
  // projection carries no `you.mafiaRoster` for her). Dave's NAME appears in
  // her watch picker (every name is public) — the leak-safety here is that no
  // roster/associate block reveals Dave as MAFIA, which the roster-count-0
  // check above covers. (Under the old idle villager UI there was no picker,
  // so a bare "Dave" appearing anywhere meant a roster leak; that's no longer
  // a valid signal now that every player sees the same target list.)
  await expect(game.carol.getByTestId("night-watch-option").first()).toBeVisible();
  await expect(game.carol.getByTestId("mafia-roster")).toHaveCount(0);
  await expect(game.carol.getByTestId("role-card-mafia-roster")).toHaveCount(0);

  // Advance to day so the day-view roster rendering path is covered too.
  // Dave (sole mafia killer) targets Bob, but Erin (angel) protects Bob the
  // same night -- nobody dies. Every living player pick→confirms (Spec 11):
  // the minion (Alice) and villager (Carol) file decoys; the detective (Bob)
  // confirms an investigate.
  await game.dave.getByTestId("night-target-option").filter({ hasText: "Bob" }).click();
  await expect(game.dave.getByTestId("lock-in-button")).toBeEnabled();
  await game.dave.getByTestId("lock-in-button").click();
  await confirmNight(game.bob, "Carol");
  await game.erin.getByTestId("night-target-option").filter({ hasText: "Bob" }).click();
  await expect(game.erin.getByTestId("night-confirm-button")).toBeEnabled();
  await game.erin.getByTestId("night-confirm-button").click();
  await settleWatch(game.alice, "Dave");
  await settleWatch(game.carol, "Dave");

  await waitForPhase(game.alice, "dawn", 25_000);
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await acknowledgeMorning(p);
  }
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

  // Spec 11: every living player pick→confirms the night.
  await game.bob.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await game.erin.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(game.bob.getByTestId("lock-in-button")).toBeEnabled();
  await game.bob.getByTestId("lock-in-button").click();
  await expect(game.erin.getByTestId("lock-in-button")).toBeEnabled();
  await game.erin.getByTestId("lock-in-button").click();
  await confirmNight(game.dave, "Carol");
  await confirmNight(game.alice, "Bob");
  await settleWatch(game.carol, "Alice");

  await waitForPhase(game.alice, "dawn", 25_000);
  for (const p of [game.alice, game.bob, game.carol, game.dave, game.erin]) {
    await acknowledgeMorning(p);
  }
  await waitForPhase(game.alice, "day", 25_000);

  const bobOption = game.alice.getByTestId("vote-option").filter({ hasText: "Bob" });
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
