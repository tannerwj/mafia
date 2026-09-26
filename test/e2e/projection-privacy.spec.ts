import { expect, test, type BrowserContext, type Page } from "@playwright/test";

type WireFrame = {
  type?: string;
  state?: { game?: Record<string, any> | null };
};

// Capture protocol frames before navigation. This deliberately observes the
// serialized WebSocket boundary rather than React state, so a private field
// cannot hide behind a UI that happens not to render it.
function captureFrames(page: Page): WireFrame[] {
  const frames: WireFrame[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      try {
        const message = JSON.parse(String(payload)) as WireFrame;
        if (message.type === "welcome" || message.type === "snapshot") frames.push(message);
      } catch {
        // Vite HMR and malformed frames are outside the room protocol.
      }
    });
  });
  return frames;
}

function gameOf(frame: WireFrame | undefined): Record<string, any> | undefined {
  return frame?.state?.game ?? undefined;
}

async function waitForFrame(
  frames: WireFrame[],
  predicate: (game: Record<string, any>) => boolean,
  timeout = 15_000,
): Promise<Record<string, any>> {
  await expect
    .poll(() => frames.some((frame) => {
      const game = gameOf(frame);
      return game !== undefined && predicate(game);
    }), { timeout })
    .toBe(true);
  return [...frames].reverse().map(gameOf).find((game): game is Record<string, any> => game !== undefined && predicate(game))!;
}

async function waitForNewFrame(
  frames: WireFrame[],
  startAt: number,
  predicate: (game: Record<string, any>) => boolean,
  timeout = 15_000,
): Promise<Record<string, any>> {
  await expect
    .poll(() => frames.slice(startAt).some((frame) => {
      const game = gameOf(frame);
      return game !== undefined && predicate(game);
    }), { timeout })
    .toBe(true);
  return [...frames].slice(startAt).reverse().map(gameOf).find((game): game is Record<string, any> => game !== undefined && predicate(game))!;
}

async function createRoomAsHost(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByTestId("create-room").click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{5}$/);
  return page.url().split("/room/")[1]!;
}

async function joinAsPlayer(page: Page, roomCode: string, name: string): Promise<void> {
  await page.goto(`/room/${roomCode}`);
  const joinAsNew = page.getByTestId("join-as-new");
  if (await joinAsNew.isVisible().catch(() => false)) await joinAsNew.click();
  await page.getByTestId("join-name-input").fill(name);
  await page.getByTestId("join-name-submit").click();
  await expect(page.getByTestId("player-list")).toContainText(name);
}

const LEGACY_EXPLICIT_ROLES_BASE = { detective: 1, angel: 1, suicide_bomber: 1, minion: 0 };

async function startGameWithSeed(host: Page, seed: number): Promise<void> {
  await host.evaluate(
    ({ seed: testSeed, roles }) => {
      sessionStorage.setItem("mafia:testSeed", String(testSeed));
      sessionStorage.setItem("mafia:testRoles", JSON.stringify(roles));
    },
    { seed, roles: LEGACY_EXPLICIT_ROLES_BASE },
  );
  await host.getByTestId("start-game").click();
}

async function waitForPhase(page: Page, phase: string): Promise<void> {
  await expect(page.getByTestId("game-screen")).toHaveAttribute("data-phase", phase, { timeout: 25_000 });
}

async function waitForRoleRevealToClose(page: Page): Promise<void> {
  await expect(page.getByTestId("role-reveal-dialog")).toHaveCount(0, { timeout: 15_000 });
}

async function submitAndLockMafiaTarget(page: Page, target: string): Promise<void> {
  await page.getByTestId("night-target-option").filter({ hasText: target }).click();
  const lock = page.getByTestId("lock-in-button");
  await expect(lock).toBeEnabled();
  await lock.click();
}

async function submitAndConfirmNightTarget(page: Page, target: string): Promise<void> {
  await page.getByTestId("night-target-option").filter({ hasText: target }).click();
  const confirm = page.getByTestId("night-confirm-button");
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

async function settleWatch(page: Page, target: string): Promise<void> {
  await page.getByTestId("night-watch-option").filter({ hasText: target }).first().click();
  const confirm = page.getByTestId("night-confirm-button");
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

async function castAndConfirmVote(page: Page, target: string): Promise<void> {
  await page.getByTestId("vote-option").filter({ hasText: target }).click();
  const confirm = page.getByTestId("confirm-vote-button");
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

async function castAndConfirmNoMurder(page: Page): Promise<void> {
  await page.getByTestId("vote-option-no-murder").click();
  const confirm = page.getByTestId("confirm-vote-button");
  await expect(confirm).toBeEnabled();
  await confirm.click();
}

test("serialized projections keep private history private while dead views retain resolved history", async ({ browser }, testInfo) => {
  testInfo.setTimeout(240_000);
  const contexts: BrowserContext[] = [];
  try {
    const hostContext = await browser.newContext(); contexts.push(hostContext);
    const aliceContext = await browser.newContext(); contexts.push(aliceContext);
    const bobContext = await browser.newContext(); contexts.push(bobContext);
    const carolContext = await browser.newContext(); contexts.push(carolContext);
    const daveContext = await browser.newContext(); contexts.push(daveContext);
    const erinContext = await browser.newContext(); contexts.push(erinContext);

    const host = await hostContext.newPage();
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const carol = await carolContext.newPage();
    const dave = await daveContext.newPage();
    const erin = await erinContext.newPage();
    const hostFrames = captureFrames(host);
    const carolFrames = captureFrames(carol);
    const daveFrames = captureFrames(dave);

    const roomCode = await createRoomAsHost(host);
    await joinAsPlayer(alice, roomCode, "Alice");
    await joinAsPlayer(bob, roomCode, "Bob");
    await joinAsPlayer(carol, roomCode, "Carol");
    await joinAsPlayer(dave, roomCode, "Dave");
    await joinAsPlayer(erin, roomCode, "Erin");
    await startGameWithSeed(host, 42);

    // The listeners above were installed before any room navigation/start
    // broadcast. Seed 42 is the existing deterministic map: Alice detective,
    // Bob+Erin mafia, Carol bomber, Dave angel.
    const startHost = await waitForFrame(hostFrames, (game) => game.phase === "night" && game.phaseGen === 0);
    const startDave = await waitForFrame(daveFrames, (game) => game.phase === "night" && game.phaseGen === 0);
    expect(startHost.log.some((event: any) => event.type === "gameStarted")).toBe(true);
    expect(startDave.log.some((event: any) => event.type === "gameStarted")).toBe(false);
    expect(startDave.players.some((player: any) => player.roleId)).toBe(false);

    for (const page of [alice, bob, carol, dave, erin]) await waitForRoleRevealToClose(page);
    await submitAndLockMafiaTarget(bob, "Carol");
    await submitAndLockMafiaTarget(erin, "Carol");
    await submitAndConfirmNightTarget(alice, "Bob");
    await submitAndConfirmNightTarget(dave, "Carol");
    await settleWatch(carol, "Alice");

    await Promise.all([alice, bob, carol, dave, erin].map((page) => waitForPhase(page, "dawn")));
    await expect(alice.getByTestId("interstitial-lines")).toContainText("The attack failed.");
    await expect(alice.getByTestId("interstitial-lines")).not.toContainText("Carol");

    const dawnHost = await waitForFrame(hostFrames, (game) => game.phase === "dawn" && game.phaseGen === 1);
    const dawnDave = await waitForFrame(daveFrames, (game) => game.phase === "dawn" && game.phaseGen === 1);
    expect(dawnHost.log.some((event: any) => event.type === "attackAttempted")).toBe(true);
    expect(dawnHost.log.some((event: any) => event.type === "investigationResult")).toBe(true);
    expect(dawnDave.log.some((event: any) => ["attackAttempted", "investigationResult"].includes(event.type))).toBe(false);
    expect(dawnDave.attackFailedDays).toEqual([1]);
    expect(dawnDave.you?.investigationResults).toBeUndefined();

    await alice.getByTestId("my-role-button").click();
    await expect(alice.getByTestId("detective-findings")).toContainText("Mafia");
    await alice.getByTestId("my-role-dialog-close").click();

    await Promise.all([alice, bob, carol, dave, erin].map((page) => page.getByTestId("acknowledge-button").click()));
    await Promise.all([alice, bob, carol, dave, erin].map((page) => waitForPhase(page, "day")));

    const daveBeforeVote = daveFrames.length;
    await castAndConfirmVote(alice, "Bob");
    const hostAfterVote = await waitForNewFrame(hostFrames, 0, (game) => game.phase === "day" && game.votes?.some((vote: any) => vote.playerId));
    const daveAfterVote = await waitForNewFrame(daveFrames, daveBeforeVote, (game) => game.phase === "day");
    expect(hostAfterVote.votes?.length).toBeGreaterThan(0);
    expect(daveAfterVote.votes).toBeUndefined();
    expect(daveAfterVote.voted).toBeUndefined();
    expect(daveAfterVote.log.some((event: any) => ["voteCast", "voteLocked", "voteRetracted", "voteUnlocked"].includes(event.type))).toBe(false);

    // Finish this day with Bob eliminated. Carol stays alive so the second
    // night can produce a landed death while the first night already proved
    // the public failed-attack wording.
    await castAndConfirmVote(bob, "Alice");
    await castAndConfirmVote(carol, "Bob");
    await castAndConfirmVote(dave, "Bob");
    await castAndConfirmVote(erin, "Bob");
    await waitForFrame(hostFrames, (game) => game.phase === "night" && game.day === 2);
    await waitForPhase(alice, "night");

    // Night 2: Erin kills Carol, while Alice investigates and Dave protects
    // Alice. Carol's post-death frame should expose the resolved history.
    await submitAndLockMafiaTarget(erin, "Carol");
    await submitAndConfirmNightTarget(alice, "Erin");
    await submitAndConfirmNightTarget(dave, "Alice");
    await settleWatch(carol, "Alice");
    await Promise.all([alice, bob, dave, erin, carol].map((page) => waitForPhase(page, "dawn")));
    await expect(carol.getByTestId("dead-god-view")).toBeVisible();
    const dawn2Host = await waitForFrame(hostFrames, (game) => game.phase === "dawn" && game.day === 2);
    const dawn2Dave = await waitForFrame(daveFrames, (game) => game.phase === "dawn" && game.day === 2);
    expect(dawn2Host.log.some((event: any) => event.type === "attackAttempted" && event.outcome === "landed")).toBe(true);
    expect(dawn2Dave.log.some((event: any) => event.type === "attackAttempted")).toBe(false);
    expect(dawn2Dave.attackFailedDays).toEqual([1]);

    const deadAfterDeath = await waitForFrame(carolFrames, (game) => game.phase === "dawn" && game.day === 2);
    expect(deadAfterDeath.players.every((player: any) => player.roleId)).toBe(true);
    expect(deadAfterDeath.log.some((event: any) => event.type === "attackAttempted")).toBe(true);
    expect(deadAfterDeath.log.some((event: any) => event.type === "investigationResult")).toBe(true);

    // Carry the dead viewer into another unresolved night. Current action
    // submission remains absent even after Erin picks a target.
    await Promise.all([alice, dave, erin].map((page) => page.getByTestId("acknowledge-button").click()));
    await Promise.all([alice, dave, erin].map((page) => waitForPhase(page, "day")));
    await castAndConfirmNoMurder(alice);
    await castAndConfirmNoMurder(dave);
    await castAndConfirmNoMurder(erin);
    await waitForFrame(hostFrames, (game) => game.phase === "night" && game.day === 3);
    await waitForPhase(alice, "night");
    const carolBeforeNight3 = carolFrames.length;
    await submitAndLockMafiaTarget(erin, "Dave");
    const carolNight = await waitForNewFrame(carolFrames, carolBeforeNight3, (game) => game.phase === "night" && game.day === 3);
    expect(carolNight.players.every((player: any) => player.roleId)).toBe(true);
    expect(carolNight.votes).toBeUndefined();
    expect(carolNight.you?.pendingAction).toBeUndefined();
    expect(carolNight.you?.nightActionLocked).toBeUndefined();
    expect(carolNight.you?.currentVote).toBeUndefined();
    expect(carolNight.you?.dayVoteLocked).toBeUndefined();
    expect(carolNight.you?.factionVotes).toBeUndefined();
    expect(carolNight.log.some((event: any) => event.type === "attackAttempted")).toBe(true);
    expect(carolNight.log.some((event: any) => event.type === "investigationResult")).toBe(true);
    expect(carolNight.log.some((event: any) => ["actionSubmitted", "actionLocked", "voteCast", "voteLocked", "acknowledged"].includes(event.type))).toBe(false);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
