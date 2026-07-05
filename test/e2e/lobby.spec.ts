import { expect, test, type Page } from "@playwright/test";

// Full-stack multi-context lobby flows (Spec 01, D6). Each `browser.newContext()`
// is a distinct browser profile (distinct storage), so two contexts are always
// two distinct identities; two pages in ONE context share storage, which is
// what proves per-tab sessionStorage makes them distinct players anyway.

async function createRoomAsHost(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByTestId("create-room").click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{5}$/);
  const url = page.url();
  return url.split("/room/")[1]!;
}

async function joinAsPlayer(page: Page, roomCode: string, name: string) {
  await page.goto(`/room/${roomCode}`);
  // A shared browser context may already hold a localStorage seat backup
  // from an earlier join in this same test (two pages, one context) — that
  // shows the seat picker instead of the join form directly.
  const joinAsNew = page.getByTestId("join-as-new");
  if (await joinAsNew.isVisible().catch(() => false)) {
    await joinAsNew.click();
  }
  await page.getByTestId("join-name-input").fill(name);
  await page.getByTestId("join-name-submit").click();
  await expect(page.getByTestId("player-list")).toContainText(name);
}

test("host creates room; two players join and appear in the lobby", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  const p1 = await p1Ctx.newPage();
  const p2 = await p2Ctx.newPage();
  await joinAsPlayer(p1, roomCode, "Alice");
  await joinAsPlayer(p2, roomCode, "Bob");

  // The host identity renders the Spec 05 host console (HostLobby), not the
  // player-facing Lobby.tsx — its player table uses its own testids.
  await expect(hostPage.getByTestId("host-player-table")).toContainText("Alice");
  await expect(hostPage.getByTestId("host-player-table")).toContainText("Bob");

  await hostCtx.close();
  await p1Ctx.close();
  await p2Ctx.close();
});

test("player reload mid-lobby keeps the same seat, no duplicate row", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  const playerPage = await playerCtx.newPage();
  await joinAsPlayer(playerPage, roomCode, "Carol");

  await playerPage.reload();
  await expect(playerPage.getByTestId("player-list")).toContainText("Carol");
  const rows = playerPage.getByTestId("player-row");
  await expect(rows).toHaveCount(1);

  await hostCtx.close();
  await playerCtx.close();
});

test("two pages in one browser context are two distinct players", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const sharedCtx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  const pageA = await sharedCtx.newPage();
  const pageB = await sharedCtx.newPage();
  await joinAsPlayer(pageA, roomCode, "Dave");
  await joinAsPlayer(pageB, roomCode, "Erin");

  await expect(hostPage.getByTestId("host-player-table")).toContainText("Dave");
  await expect(hostPage.getByTestId("host-player-table")).toContainText("Erin");
  await expect(hostPage.getByTestId("host-player-row")).toHaveCount(2);

  await hostCtx.close();
  await sharedCtx.close();
});

test("kick removes the player everywhere and shows them the join screen", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  const playerPage = await playerCtx.newPage();
  await joinAsPlayer(playerPage, roomCode, "Frank");

  await hostPage
    .getByTestId("host-player-row")
    .filter({ hasText: "Frank" })
    .getByTestId("kick-button")
    .click();

  await expect(playerPage.getByTestId("kicked-message")).toBeVisible();
  await expect(hostPage.getByTestId("host-player-table")).not.toContainText(
    "Frank",
  );

  await hostCtx.close();
  await playerCtx.close();
});

test("socket drop shows the reconnect banner then recovers the same seat", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  // `context.setOffline(true)` alone doesn't sever an already-open WebSocket
  // in Chromium (it only blocks new connection attempts — the existing
  // socket's transport is untouched). To simulate a real drop, wrap the
  // page's WebSocket constructor before navigation so the test can reach in
  // and force-close whatever socket the app opened, purely test-side.
  // This runs as a string in the browser, not under this file's (DOM-less)
  // tsconfig, so it's typed loosely on purpose.
  await playerCtx.addInitScript(() => {
    const g = globalThis as any;
    const NativeWebSocket = g.WebSocket;
    const openSockets = new Set<unknown>();
    g.__openSockets = openSockets;
    g.WebSocket = function (this: unknown, ...args: unknown[]) {
      const sock = new NativeWebSocket(...args);
      openSockets.add(sock);
      sock.addEventListener("close", () => openSockets.delete(sock));
      return sock;
    };
    g.WebSocket.prototype = NativeWebSocket.prototype;
    for (const key of Object.keys(NativeWebSocket)) {
      g.WebSocket[key] = NativeWebSocket[key];
    }
  });

  const playerPage = await playerCtx.newPage();
  await joinAsPlayer(playerPage, roomCode, "Gina");

  await playerCtx.setOffline(true);
  await playerPage.evaluate(() => {
    const sockets = (globalThis as any).__openSockets as Set<{
      close: () => void;
    }>;
    for (const ws of sockets) {
      ws.close();
    }
  });
  await expect(playerPage.getByTestId("connection-banner")).toBeVisible({
    timeout: 15_000,
  });

  await playerCtx.setOffline(false);
  await expect(playerPage.getByTestId("connection-banner")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(playerPage.getByTestId("player-list")).toContainText("Gina");
  await expect(playerPage.getByTestId("player-row")).toHaveCount(1);

  await hostCtx.close();
  await playerCtx.close();
});

test("seat picker offers rejoin after closing and reopening the room URL", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();

  const hostPage = await hostCtx.newPage();
  const roomCode = await createRoomAsHost(hostPage);

  const playerPage: Page = await playerCtx.newPage();
  await joinAsPlayer(playerPage, roomCode, "Hank");

  // Close the tab (drops sessionStorage) and reopen the room URL — the
  // localStorage backup should offer "Rejoin as Hank".
  await playerPage.close();
  const reopened = await playerCtx.newPage();
  await reopened.goto(`/room/${roomCode}`);
  await expect(reopened.getByTestId("rejoin-backup")).toContainText(
    "Rejoin as Hank",
  );

  // Picking "someone new" preserves the Hank backup entry.
  await reopened.getByTestId("join-as-new").click();
  await reopened.getByTestId("join-name-input").fill("Iris");
  await reopened.getByTestId("join-name-submit").click();
  await expect(reopened.getByTestId("player-list")).toContainText("Iris");

  await reopened.close();
  const thirdVisit = await playerCtx.newPage();
  await thirdVisit.goto(`/room/${roomCode}`);
  await expect(thirdVisit.getByTestId("rejoin-backup")).toHaveCount(2);
  await expect(thirdVisit.getByTestId("rejoin-backup")).toContainText([
    "Rejoin as Hank",
    "Rejoin as Iris",
  ]);

  await hostCtx.close();
  await playerCtx.close();
});
