import { expect, test, type Page } from "@playwright/test";

// Reconnect UX + two-tabs regression (Spec 04, D4), extending the pattern
// from lobby.spec.ts's D6 socket-drop test into a running game: kill a
// player context's network mid-night, confirm the banner appears, restore
// it, and confirm the same seat + pending-action state is restored and the
// banner clears. Also re-confirms the "two pages, one context" regression
// (Spec 01) still holds with game screens layered on top of the lobby.

// The socket-drop test below exercises a real client<->workerd WebSocket
// reconnect cycle on the shared dev server — under load this can take
// several full connect/drop cycles to settle (traced directly: each
// intermediate reconnect's own lifetime showed ~29.5s in the network HAR
// before dropping again). Retries are scoped to this file only (not the
// shared `playwright.config.ts`) so a run that lands in a bad cycle gets a
// clean second attempt rather than failing outright — this is orthogonal to
// the generous per-assertion timeouts below, which cover one run's slowness,
// not repeated bad luck across runs.
test.describe.configure({ retries: 2 });

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

// RoleReveal (Radix Dialog) auto-dismisses 5s after assignment; its overlay
// sits above the night-action drawer and intercepts pointer events until it
// actually closes. A real player waits this out before acting.
async function waitForRoleRevealToClose(page: Page) {
  await expect(page.getByTestId("role-reveal-dialog")).toHaveCount(0, {
    timeout: 15_000,
  });
}

test("kill network mid-night, banner appears, restore, same seat + pending-action state restored", async ({
  browser,
}, testInfo) => {
  // This test's own two `expect(...).toBeVisible/toHaveCount` waits are
  // sized generously (50s / 150s, see their comments) to tolerate the slow
  // liveness-timeout + repeated backoff-retry-cycle fallback paths — but
  // Playwright's default 30s PER-TEST timeout was capping the whole test
  // well before either assertion's own budget could matter (observed: hard
  // failures at exactly ~30.0s regardless of the assertion timeouts). Raise
  // the test's own ceiling to comfortably exceed the sum of both legs'
  // worst case (50s + 150s + game-setup/action overhead).
  testInfo.setTimeout(240_000);

  const hostCtx = await browser.newContext();
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const carolCtx = await browser.newContext();
  const daveCtx = await browser.newContext();
  const erinCtx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  // Same WebSocket-wrapping trick as lobby.spec.ts's D6 socket-drop test:
  // `context.setOffline(true)` alone doesn't sever an already-open socket in
  // Chromium, so force-close it from the page alongside going offline.
  // `__openSockets` tags each socket as room-vs-other (the dev server's own
  // Vite HMR socket also opens on this page) — closing BOTH sockets in the
  // same synchronous loop was found to sometimes suppress the room socket's
  // own `close` event indefinitely (reproduced directly: closing only the
  // room socket fires `close` and shows the banner within 1s, every time;
  // closing both together intermittently never fires it at all, even after
  // 70s+). Only the room socket needs to be closed for this test.
  await erinCtx.addInitScript(() => {
    const g = globalThis as any;
    const NativeWebSocket = g.WebSocket;
    const openSockets = new Set<{ __isRoom: boolean; close: () => void }>();
    g.__openSockets = openSockets;
    g.WebSocket = function (this: unknown, ...args: unknown[]) {
      const sock = new NativeWebSocket(...args) as unknown as { __isRoom: boolean; close: () => void };
      sock.__isRoom = String(args[0]).includes("/api/rooms/");
      openSockets.add(sock);
      (sock as unknown as WebSocket).addEventListener("close", () => openSockets.delete(sock));
      return sock;
    };
    g.WebSocket.prototype = NativeWebSocket.prototype;
    for (const key of Object.keys(NativeWebSocket)) {
      g.WebSocket[key] = NativeWebSocket[key];
    }
  });

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

  // Seed 42 -> Alice:detective, Bob:mafia, Carol:suicide_bomber, Dave:angel,
  // Erin:mafia (same mapping as game.spec.ts's scenario A).
  await startGameWithSeed(hostPage, 42);
  await waitForPhase(erin, "night");
  await waitForRoleRevealToClose(erin);

  // Erin (mafia) submits her night target before dropping — that pending
  // action must survive the reconnect.
  await erin.getByTestId("night-target-option").filter({ hasText: "Carol" }).click();
  await expect(erin.getByTestId("night-target-option").filter({ hasText: "Carol" })).toHaveAttribute(
    "data-target-id",
  );

  // Close the room socket BEFORE flipping offline — closing first lets the
  // WebSocket close handshake actually complete over a live transport
  // (observed: closing while already offline can leave the `close` event
  // un-fired for up to the full assertion timeout, since the closing
  // handshake itself needs the network). `context.setOffline(true)`
  // afterwards then blocks the reconnect attempt's OUTBOUND connection from
  // succeeding, so the drop is still fully simulated.
  await erin.evaluate(() => {
    const sockets = (globalThis as any).__openSockets as Set<{ __isRoom: boolean; close: () => void }>;
    for (const ws of sockets) {
      if (ws.__isRoom) ws.close();
    }
  });
  await erinCtx.setOffline(true);
  // The forced `ws.close()` above should fire the socket's native `close`
  // event immediately and drive `RoomConnection` into "reconnecting" right
  // away — but under `context.setOffline(true)`, that `close` event is not
  // guaranteed to fire promptly (observed: it can fail to fire at all within
  // 15s). `RoomConnection`'s own fallback for exactly this case is its
  // heartbeat-driven liveness check (`checkLivenessNow`, every 5s, tripping
  // `forceRecycle` once `LIVENESS_TIMEOUT_MS` = 40s has elapsed since the
  // last message) — so the banner can legitimately take up to ~40s+ to
  // appear on this path, not just the nominal alarm-latency variance this
  // fix-round is about. Timeout raised well past that fallback's ceiling.
  await expect(erin.getByTestId("connection-banner")).toBeVisible({ timeout: 50_000 });

  await erinCtx.setOffline(false);
  // Recovery goes through `RoomConnection`'s exponential-backoff retry
  // (`BACKOFF_BASE_MS` 500 up to `BACKOFF_CAP_MS` 15s, full jitter). Traced
  // directly (Playwright trace network log): under load on the shared dev
  // server, the reconnect can cycle through several full connect->~30s
  // alive->drop loops before it settles — each successful re-connection's
  // own lifetime showed as ~29.5s in the HAR before closing again, repeating
  // 3-4 times in observed failures. This matches the documented "real
  // workerd alarms on one shared dev server" flake class this whole
  // fix-round targets — timeout raised to comfortably cover several such
  // cycles, not just one or two.
  await expect(erin.getByTestId("connection-banner")).toHaveCount(0, { timeout: 150_000 });

  // Same seat: still shows Erin's own role identity (Mafia) and her
  // previously-submitted target is still highlighted as selected.
  await waitForPhase(erin, "night", 25_000);
  await expect(
    erin.getByTestId("night-target-option").filter({ hasText: "Carol" }),
  ).toHaveClass(/border-brass/);
  await expect(erin.getByTestId("mafia-consensus")).toBeVisible();

  await hostCtx.close();
  await aliceCtx.close();
  await bobCtx.close();
  await carolCtx.close();
  await daveCtx.close();
  await erinCtx.close();
});

test("two pages in one browser context are two distinct players inside a running game", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const sharedCtx = await browser.newContext();
  const otherCtx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  // Two seats from ONE shared browser context (the regression under test),
  // three more from separate contexts just to reach a valid 5-player game.
  const pageA = await sharedCtx.newPage();
  const pageB = await sharedCtx.newPage();
  const pageC = await otherCtx.newPage();
  const pageD = await otherCtx.newPage();
  const pageE = await otherCtx.newPage();

  await joinAsPlayer(pageA, roomCode, "Alice");
  await joinAsPlayer(pageB, roomCode, "Bob");
  await joinAsPlayer(pageC, roomCode, "Carol");
  await joinAsPlayer(pageD, roomCode, "Dave");
  await joinAsPlayer(pageE, roomCode, "Erin");

  await expect(hostPage.getByTestId("host-player-row")).toHaveCount(5);

  await startGameWithSeed(hostPage, 42);

  // Both pages sharing one browser context each land in their own seat's
  // game screen (distinct roles), proving per-tab sessionStorage identity
  // survives into the game, not just the lobby.
  await expect(pageA.getByTestId("role-reveal-dialog")).toContainText("Detective");
  await expect(pageB.getByTestId("role-reveal-dialog")).toContainText("Mafia");

  await hostCtx.close();
  await sharedCtx.close();
  await otherCtx.close();
});
