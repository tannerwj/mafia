import { expect, test, type Page } from "@playwright/test";

// Full-stack multi-context game flows (Spec 04, D4). Builds on lobby.spec.ts's
// pattern: each `browser.newContext()` is a distinct browser profile/player.
// Deterministic via Spec 03 v2.1's env-gated `start_game.seed` (the dev
// server sets `ALLOW_TEST_SEED=1` via `.dev.vars`) + a fixed join order —
// each scenario documents its derived role assignment (verified directly
// against `startGame(players, HOUSE_RULES, seed, 0)` before being pinned
// here; see docs/specs/04-implementation-notes.md).
//
// The client's "Start game" trigger (Lobby.tsx, host-only) always sends
// `HOUSE_RULES`'s exact shape (src/client/lib/houseRuleset.ts's
// `HOUSE_RULESET` mirrors it) — for 5 players that formula
// (`autoMafiaCount(5, "sqrt") = round(sqrt(5)) = 2`) always yields exactly
// 2 mafia, 1 detective, 1 angel, 1 suicide_bomber, 0 villagers. Every
// scenario below accounts for 2 mafia, not 1 (a solo-mafia 5-player game is
// not reachable through this ruleset).
//
// Dawn/dusk beats auto-advance on their own after `dawnDuskBeatMs` (house
// rules: 3000ms) — these tests wait for the resulting phase/text rather than
// using `force_advance`, since that's the real unattended path a table
// actually plays through (per 03-implementation-notes.md's fix-round-1).

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

async function submitNightTarget(page: Page, targetName: string) {
  await page.getByTestId("night-target-option").filter({ hasText: targetName }).click();
}

// Spec 08: `lock-in-button` is disabled until the server confirms the
// voter's own pending target (`you.pendingAction`), NOT merely once the
// local click-selection styling applies -- clicking it before that
// round-trip lands is a real race (observed: the click can silently no-op
// on a still-disabled button). Waiting for the enabled state first makes
// this deterministic.
async function submitAndLockMafiaTarget(page: Page, targetName: string) {
  await submitNightTarget(page, targetName);
  const lockButton = page.getByTestId("lock-in-button");
  await expect(lockButton).toBeEnabled();
  await lockButton.click();
}

// RoleReveal (Radix Dialog) auto-dismisses 5s after assignment; its overlay
// sits above the night-action drawer and intercepts pointer events until it
// actually closes. A real player waits this out (or dismisses it) before
// acting — these tests do the same rather than racing the timer.
async function waitForRoleRevealToClose(page: Page) {
  await expect(page.getByTestId("role-reveal-dialog")).toHaveCount(0, {
    timeout: 15_000,
  });
}

async function castDayVote(page: Page, targetName: string) {
  await page.getByTestId("vote-option").filter({ hasText: targetName }).click();
}

async function castNoMurder(page: Page) {
  await page.getByTestId("vote-option-no-murder").click();
}

// ---------------------------------------------------------------------------
// Scenario A: seed 42, house ruleset -> Alice:detective, Bob:mafia,
// Carol:suicide_bomber, Dave:angel, Erin:mafia (5 players under
// `HOUSE_RULES`'s auto mafia formula always yields 2 mafia).
// Script: night 1 the mafia (Bob+Erin) converge on Carol; angel (Dave)
// protects Carol -> the attack fails and dawn announces it; detective
// (Alice) investigates Bob -> mafia. Day 1 vote is engineered to tie 2-2
// between Bob and Carol so a runoff triggers; the runoff eliminates Bob
// (one mafia down, one to go -- parity math means the game can't end yet
// with 1 mafia vs 3 others alive). Night 2 the remaining mafia (Erin) kills
// Carol (no save this time); day 2 the village votes out Erin -> mafia
// count hits zero -> village wins.
// ---------------------------------------------------------------------------
test.describe("scenario A: mafia converge, angel save, failed-attack dawn message, runoff, village win", () => {
  test("full 5-player game through the real UI", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const carolCtx = await browser.newContext();
    const daveCtx = await browser.newContext();
    const erinCtx = await browser.newContext();

    const hostPage = await hostCtx.newPage();
    const roomCode = await createRoomAsHost(hostPage);

    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    const carol = await carolCtx.newPage();
    const dave = await daveCtx.newPage();
    const erin = await erinCtx.newPage();

    await joinAsPlayer(alice, roomCode, "Alice");
    await joinAsPlayer(bob, roomCode, "Bob");
    await joinAsPlayer(carol, roomCode, "Carol");
    await joinAsPlayer(dave, roomCode, "Dave");
    await joinAsPlayer(erin, roomCode, "Erin");

    await startGameWithSeed(hostPage, 42);

    await waitForPhase(alice, "night");
    for (const p of [bob, carol, dave, erin]) await waitForPhase(p, "night");

    await expect(alice.getByTestId("role-reveal-dialog")).toContainText("Detective");
    await expect(bob.getByTestId("role-reveal-dialog")).toContainText("Mafia");
    await expect(carol.getByTestId("role-reveal-dialog")).toContainText("Suicide Bomber");
    await expect(dave.getByTestId("role-reveal-dialog")).toContainText("Angel");
    await expect(erin.getByTestId("role-reveal-dialog")).toContainText("Mafia");

    // DOM-level privacy assertion: the suicide bomber (Carol, village-facing
    // from every other player's perspective) must never see another living
    // player's role string anywhere in her page. Scoped to the React-rendered
    // app root, not the full document — the static `<title>Mafia</title>` in
    // <head> is app chrome, not player-facing role data, and would otherwise
    // false-positive on the app's own name colliding with a role name.
    const carolAppHtml = await carol.locator("#root").innerHTML();
    expect(carolAppHtml).not.toContain("Mafia");
    expect(carolAppHtml).not.toContain("Detective");
    expect(carolAppHtml).not.toContain("Angel");

    // Night 1: mafia (Bob + Erin) converge on Carol; angel (Dave) protects
    // Carol -> the attack fails (scripted "angel save"). Detective (Alice)
    // investigates Bob.
    for (const p of [alice, bob, carol, dave, erin]) {
      await waitForRoleRevealToClose(p);
    }
    await submitNightTarget(bob, "Carol");
    await submitNightTarget(erin, "Carol");

    // Mafia consensus state is visible only to mafia, from their own
    // `you.factionVotes`/`you.consensusReached`/`you.lockedCount` — never a
    // fabricated pending-count for anyone else. Both tentative picks match,
    // but consensus is NOT reached until both lock in (Spec 08).
    await expect(bob.getByTestId("mafia-consensus")).toHaveAttribute("data-consensus-reached", "false");
    await expect(bob.getByTestId("lock-in-button")).toBeEnabled();
    await bob.getByTestId("lock-in-button").click();
    await expect(erin.getByTestId("lock-in-button")).toBeEnabled();
    await erin.getByTestId("lock-in-button").click();
    await expect(bob.getByTestId("mafia-consensus")).toHaveAttribute("data-consensus-reached", "true");

    await submitNightTarget(dave, "Carol");
    await submitNightTarget(alice, "Bob");

    await waitForPhase(alice, "dawn", 25_000);
    await expect(alice.getByTestId("interstitial-lines")).toContainText("attack failed");
    for (const p of [bob, carol, dave, erin]) {
      await waitForPhase(p, "dawn", 25_000);
    }

    await waitForPhase(alice, "day", 25_000);
    for (const p of [bob, carol, dave, erin]) await waitForPhase(p, "day", 25_000);

    // Day 1: engineer a 2-2 tie between Bob and Carol (Erin gets the odd
    // vote out) so the vote goes to a runoff.
    await castDayVote(alice, "Bob");
    await castDayVote(dave, "Bob");
    await castDayVote(carol, "Erin");
    await castDayVote(erin, "Carol");
    await castDayVote(bob, "Carol");

    await waitForPhase(alice, "runoff", 25_000);
    for (const p of [bob, carol, dave, erin]) await waitForPhase(p, "runoff", 25_000);
    // Runoff renders only the tied candidates -- no_murder must not appear.
    await expect(alice.getByTestId("vote-option-no-murder")).toHaveCount(0);
    await expect(alice.getByTestId("vote-option")).toHaveCount(2);

    // Runoff: everyone votes out Bob (one mafia down; Erin remains).
    for (const p of [alice, bob, carol, dave, erin]) {
      await castDayVote(p, "Bob");
    }

    // One mafia down but parity isn't met yet (1 mafia vs 3 others) -> the
    // game continues to night 2, it does not end here.
    await waitForPhase(alice, "night", 25_000);
    await expect(alice.getByTestId("game-screen")).not.toHaveAttribute("data-phase", "ended");

    // Night 2: the remaining mafia (Erin) kills Carol -- no save this time.
    await submitAndLockMafiaTarget(erin, "Carol");
    await submitNightTarget(dave, "Alice");
    await submitNightTarget(alice, "Erin");

    // Night 1's investigation result (Bob -> mafia) resolved at dawn 1 and
    // now shows in the detective's own waiting-on-submission state.
    await expect(alice.getByTestId("investigation-history")).toContainText("Mafia");

    await waitForPhase(alice, "dawn", 25_000);
    await expect(alice.getByTestId("interstitial-lines")).toContainText("Carol");

    await waitForPhase(alice, "day", 25_000);
    for (const p of [dave, erin]) await waitForPhase(p, "day", 25_000);

    // Carol is dead -- she gets the god view, never a pending-action
    // placeholder for a phase she can no longer act in.
    await expect(carol.getByTestId("dead-god-view")).toBeVisible();

    // Day 2: the surviving village votes out Erin (the last mafia) ->
    // mafia count hits zero -> village wins.
    await castDayVote(alice, "Erin");
    await castDayVote(dave, "Erin");
    await castNoMurder(erin);

    await waitForPhase(alice, "ended", 25_000);
    for (const p of [dave, erin]) await waitForPhase(p, "ended", 25_000);
    await expect(alice.getByTestId("winner-splash")).toContainText("village");
    await expect(alice.getByTestId("final-roles")).toContainText("Mafia");

    await hostCtx.close();
    await aliceCtx.close();
    await bobCtx.close();
    await carolCtx.close();
    await daveCtx.close();
    await erinCtx.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario B: suicide-bomber loss variant. Seed 1, house ruleset ->
// Alice:mafia, Bob:suicide_bomber, Carol:angel, Dave:detective, Erin:mafia.
// Script: night 1 the mafia (Alice+Erin) target Dave, but angel (Carol)
// protects Dave -> the attack fails and nobody dies. (5 players under
// `HOUSE_RULES`'s real auto-formula always yields 2 mafia, and this ruleset's
// parity is "immediate" -- mafiaTeam(2) >= everyoneElse once ANY one of the
// 3 non-mafia dies, which would end the game at night 1 before reaching a
// day vote at all; a scripted save is the only way night 1 doesn't end the
// game outright.) Day 1 the village votes out Bob (indistinguishable from a
// villager to everyone else) -> his win-hook fires immediately on the
// `playerDied{cause:'vote'}` event, ending the game with him as the sole
// winner regardless of the still-living mafia -- a "village loss" in the
// sense the village's own vote handed the game to a third party.
// ---------------------------------------------------------------------------
test.describe("scenario B: suicide-bomber loss variant", () => {
  test("village votes out the bomber and he wins alone", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const carolCtx = await browser.newContext();
    const daveCtx = await browser.newContext();
    const erinCtx = await browser.newContext();

    const hostPage = await hostCtx.newPage();
    const roomCode = await createRoomAsHost(hostPage);

    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    const carol = await carolCtx.newPage();
    const dave = await daveCtx.newPage();
    const erin = await erinCtx.newPage();

    await joinAsPlayer(alice, roomCode, "Alice");
    await joinAsPlayer(bob, roomCode, "Bob");
    await joinAsPlayer(carol, roomCode, "Carol");
    await joinAsPlayer(dave, roomCode, "Dave");
    await joinAsPlayer(erin, roomCode, "Erin");

    await startGameWithSeed(hostPage, 1);

    await waitForPhase(alice, "night");
    for (const p of [bob, carol, dave, erin]) await waitForPhase(p, "night");

    await expect(alice.getByTestId("role-reveal-dialog")).toContainText("Mafia");
    await expect(bob.getByTestId("role-reveal-dialog")).toContainText("Suicide Bomber");
    await expect(carol.getByTestId("role-reveal-dialog")).toContainText("Angel");
    await expect(dave.getByTestId("role-reveal-dialog")).toContainText("Detective");
    await expect(erin.getByTestId("role-reveal-dialog")).toContainText("Mafia");

    // Night 1: mafia (Alice + Erin) target Dave; angel (Carol) protects
    // Dave -> the attack fails, nobody dies (required so parity doesn't end
    // the game here -- see the scenario comment above).
    for (const p of [alice, bob, carol, dave, erin]) {
      await waitForRoleRevealToClose(p);
    }
    await submitNightTarget(alice, "Dave");
    await expect(alice.getByTestId("lock-in-button")).toBeEnabled();
    await alice.getByTestId("lock-in-button").click();
    await submitNightTarget(erin, "Dave");
    await expect(erin.getByTestId("lock-in-button")).toBeEnabled();
    await erin.getByTestId("lock-in-button").click();
    await submitNightTarget(carol, "Dave");
    await submitNightTarget(dave, "Alice");

    await waitForPhase(alice, "dawn", 25_000);
    await expect(alice.getByTestId("interstitial-lines")).toContainText("attack failed");

    await waitForPhase(alice, "day", 25_000);
    for (const p of [bob, carol, dave, erin]) await waitForPhase(p, "day", 25_000);

    // Day 1: the full village (everyone survived night 1) votes out Bob --
    // from every other player's point of view he's just another suspect.
    await castDayVote(alice, "Bob");
    await castDayVote(bob, "Bob");
    await castDayVote(carol, "Bob");
    await castDayVote(dave, "Bob");
    await castDayVote(erin, "Bob");

    await waitForPhase(alice, "ended", 25_000);
    for (const p of [carol, erin]) await waitForPhase(p, "ended", 25_000);
    await expect(alice.getByTestId("winner-splash")).toContainText("bomber");
    await expect(alice.getByTestId("final-roles")).toContainText("Suicide Bomber");

    await hostCtx.close();
    await aliceCtx.close();
    await bobCtx.close();
    await carolCtx.close();
    await daveCtx.close();
    await erinCtx.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario C: village-win variant (no runoff, no bomber loss). Seed 59,
// house ruleset -> Alice:mafia, Bob:mafia, Carol:detective, Dave:suicide_
// bomber, Erin:angel.
// Script: night 1 the mafia (Alice+Bob) target Dave; angel (Erin) protects
// Dave too -> the attack fails, nobody dies. (Same parity constraint as
// scenario B: 2 mafia vs 3 others under `HOUSE_RULES`'s real auto-formula
// hits immediate parity the instant any one of the 3 non-mafia dies, so
// night 1 must be a clean save to reach a day vote at all.) Day 1 the
// village votes out Alice (one mafia down, one to go -- 1 mafia vs 3 others,
// not parity). Night 2 the remaining mafia (Bob) targets Carol; angel (Erin)
// protects Carol this time -> the attack fails again. Day 2 the village
// votes out Bob -> mafia count hits zero -> village wins.
// ---------------------------------------------------------------------------
test.describe("scenario C: village-win variant", () => {
  test("two clean day votes eliminate both mafia", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const carolCtx = await browser.newContext();
    const daveCtx = await browser.newContext();
    const erinCtx = await browser.newContext();

    const hostPage = await hostCtx.newPage();
    const roomCode = await createRoomAsHost(hostPage);

    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    const carol = await carolCtx.newPage();
    const dave = await daveCtx.newPage();
    const erin = await erinCtx.newPage();

    await joinAsPlayer(alice, roomCode, "Alice");
    await joinAsPlayer(bob, roomCode, "Bob");
    await joinAsPlayer(carol, roomCode, "Carol");
    await joinAsPlayer(dave, roomCode, "Dave");
    await joinAsPlayer(erin, roomCode, "Erin");

    await startGameWithSeed(hostPage, 59);

    await waitForPhase(alice, "night");
    for (const p of [bob, carol, dave, erin]) await waitForPhase(p, "night");

    await expect(alice.getByTestId("role-reveal-dialog")).toContainText("Mafia");
    await expect(bob.getByTestId("role-reveal-dialog")).toContainText("Mafia");
    await expect(carol.getByTestId("role-reveal-dialog")).toContainText("Detective");
    await expect(dave.getByTestId("role-reveal-dialog")).toContainText("Suicide Bomber");
    await expect(erin.getByTestId("role-reveal-dialog")).toContainText("Angel");

    // Night 1: mafia (Alice + Bob) target Dave; angel (Erin) protects Dave
    // too -> the attack fails, nobody dies (required so parity doesn't end
    // the game here -- see the scenario comment above). Detective (Carol)
    // investigates Alice.
    for (const p of [alice, bob, carol, dave, erin]) {
      await waitForRoleRevealToClose(p);
    }
    await submitNightTarget(alice, "Dave");
    await expect(alice.getByTestId("lock-in-button")).toBeEnabled();
    await alice.getByTestId("lock-in-button").click();
    await submitNightTarget(bob, "Dave");
    await expect(bob.getByTestId("lock-in-button")).toBeEnabled();
    await bob.getByTestId("lock-in-button").click();
    await submitNightTarget(erin, "Dave");
    await submitNightTarget(carol, "Alice");

    await waitForPhase(alice, "dawn", 25_000);
    await expect(alice.getByTestId("interstitial-lines")).toContainText("attack failed");

    await waitForPhase(alice, "day", 25_000);
    for (const p of [bob, carol, dave, erin]) await waitForPhase(p, "day", 25_000);

    // Day 1: everyone survived night 1. Vote out Alice (one mafia down, one
    // to go -- 1 mafia vs 3 others, not parity).
    await castDayVote(bob, "Alice");
    await castDayVote(carol, "Alice");
    await castDayVote(dave, "Alice");
    await castDayVote(erin, "Alice");
    await castNoMurder(alice);

    // One mafia down, still not ended (1 mafia vs 3 others).
    await waitForPhase(carol, "night", 25_000);
    await expect(carol.getByTestId("game-screen")).not.toHaveAttribute("data-phase", "ended");

    // Night 1's investigation result (Alice -> mafia) resolved at dawn 1 and
    // now shows in the detective's own waiting-on-submission state, once she
    // has a pending night-2 action to be waiting on.
    await submitNightTarget(carol, "Bob");
    await expect(carol.getByTestId("investigation-history")).toContainText("Mafia");

    // Night 2: remaining mafia (Bob) targets Carol; angel (Erin) protects
    // Carol this time -> the attack fails. Dave (suicide_bomber) has no
    // night action -- idle "town sleeps" state, nothing to submit.
    await submitAndLockMafiaTarget(bob, "Carol");
    await submitNightTarget(erin, "Carol");

    await waitForPhase(carol, "dawn", 25_000);
    await expect(carol.getByTestId("interstitial-lines")).toContainText("attack failed");

    await waitForPhase(carol, "day", 25_000);
    for (const p of [bob, dave, erin]) await waitForPhase(p, "day", 25_000);

    // Day 2: alive = Bob, Carol, Dave, Erin. Vote out Bob -> mafia count
    // zero -> village wins.
    await castDayVote(carol, "Bob");
    await castDayVote(dave, "Bob");
    await castDayVote(erin, "Bob");
    await castNoMurder(bob);

    await waitForPhase(carol, "ended", 25_000);
    for (const p of [bob, dave, erin]) await waitForPhase(p, "ended", 25_000);
    await expect(carol.getByTestId("winner-splash")).toContainText("village");

    await hostCtx.close();
    await aliceCtx.close();
    await bobCtx.close();
    await carolCtx.close();
    await daveCtx.close();
    await erinCtx.close();
  });
});
