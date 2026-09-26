import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Spec 23 D4: this test uses the real host picker and separate browser
// contexts for players. It deliberately does not reach into React state or
// call the server over HTTP. The one raw WebSocket message covers the
// player-only rejection path because players have no theme control by design.

const THEMES = ["atelier", "club", "rain"] as const;

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

async function expectTheme(page: Page, theme: (typeof THEMES)[number]) {
  await expect(page.locator("html")).toHaveAttribute("data-visual-theme", theme, {
    timeout: 10_000,
  });
}

async function waitForPhase(page: Page, phase: string) {
  await expect(page.getByTestId("game-screen")).toHaveAttribute("data-phase", phase, {
    timeout: 25_000,
  });
}

async function waitForRoleRevealToClose(page: Page) {
  await expect(page.getByTestId("role-reveal-dialog")).toHaveCount(0, {
    timeout: 15_000,
  });
}

async function closeContexts(contexts: BrowserContext[]) {
  await Promise.all(contexts.map((context) => context.close()));
}

async function installWelcomeGate(page: Page) {
  // Hold only room WebSocket welcome/snapshot callbacks when the test asks
  // for it. This makes the pre-auth window deterministic without reaching
  // into React state or changing the production protocol.
  await page.addInitScript(() => {
    const browserGlobal = globalThis as any;
    const NativeWebSocket = browserGlobal.WebSocket;
    const nativeAddEventListener = NativeWebSocket.prototype.addEventListener;
    (NativeWebSocket.prototype as any).addEventListener = function (
      type: string,
      listener: any,
      options?: any,
    ) {
      if (type !== "message" || !this.url.includes("/api/rooms/")) {
        return nativeAddEventListener.call(this, type, listener, options);
      }

      const socket = this;
      const wrapped = (event: any) => {
        let message: { type?: string } | null = null;
        try {
          message = JSON.parse(String((event as MessageEvent).data)) as { type?: string };
        } catch {
          // The production connection owns malformed-frame handling.
        }
        const shouldHold =
          (globalThis as any).__holdRoomWelcome === true &&
          (message?.type === "welcome" || message?.type === "snapshot");
        if (shouldHold) {
          ((globalThis as any).__heldRoomMessages as Array<() => void>).push(() => {
            if (typeof listener === "function") listener.call(socket, event);
            else listener.handleEvent(event);
          });
          return;
        }
        if (typeof listener === "function") listener.call(socket, event);
        else listener.handleEvent(event);
      };
      return nativeAddEventListener.call(socket, type, wrapped, options);
    };
    (globalThis as any).__holdRoomWelcome = false;
    (globalThis as any).__heldRoomMessages = [];
  });
}

async function spaNavigate(page: Page, path: string) {
  await page.evaluate((nextPath) => {
    const browserGlobal = globalThis as any;
    browserGlobal.history.pushState(null, "", nextPath);
    browserGlobal.dispatchEvent(new browserGlobal.PopStateEvent("popstate"));
  }, path);
}

test("host themes sync to the room, survive rejoin and rematch, and reject player changes", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const carolCtx = await browser.newContext();
  const contexts = [hostCtx, aliceCtx, bobCtx, carolCtx];

  // Capture only the test page's own sockets so the player authority check can
  // be exercised without adding a production-only control to the player UI.
  await aliceCtx.addInitScript(() => {
    const g = globalThis as any;
    const NativeWebSocket = g.WebSocket;
    const openSockets = new Set<any>();
    const rejectionCodes: string[] = [];
    g.__openSockets = openSockets;
    g.__rejectionCodes = rejectionCodes;
    g.WebSocket = function (this: any, ...args: any[]) {
      const socket = new NativeWebSocket(...args);
      openSockets.add(socket);
      socket.addEventListener("close", () => openSockets.delete(socket));
      socket.addEventListener("message", (event: MessageEvent) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; code?: string };
          if (message.type === "rejection" && message.code) rejectionCodes.push(message.code);
        } catch {
          // The application owns protocol parsing; the test observer ignores
          // frames it does not understand.
        }
      });
      return socket;
    };
    g.WebSocket.prototype = NativeWebSocket.prototype;
    for (const key of Object.keys(NativeWebSocket)) {
      g.WebSocket[key] = NativeWebSocket[key];
    }
  });

  try {
    const hostPage = await hostCtx.newPage();
    const roomCode = await createRoomAsHost(hostPage);

    let alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    const carol = await carolCtx.newPage();
    const players = () => [alice, bob, carol];

    await joinAsPlayer(alice, roomCode, "Alice");
    await joinAsPlayer(bob, roomCode, "Bob");
    await joinAsPlayer(carol, roomCode, "Carol");

    // Default skin is public and synchronized before the first change.
    await expectTheme(hostPage, "atelier");
    for (const player of players()) await expectTheme(player, "atelier");
    await expect(hostPage.getByTestId("theme-option-atelier")).toHaveAttribute("aria-pressed", "true");

    // Each option is selected through the visible host control. The skin is
    // considered saved only after the authoritative snapshot comes back.
    for (const theme of THEMES) {
      await hostPage.getByTestId(`theme-option-${theme}`).click();
      await expect(hostPage.getByTestId("theme-status")).toHaveAttribute("data-status", "saved");
      await expectTheme(hostPage, theme);
      for (const player of players()) await expectTheme(player, theme);
    }

    // A second host tab authenticates through the explicit recovery affordance.
    // Last committed theme revision wins and both host views converge.
    const hostPageB = await hostCtx.newPage();
    await hostPageB.goto(`/room/${roomCode}`);
    await expect(hostPageB.getByTestId("resume-as-host")).toBeVisible();
    await hostPageB.getByTestId("resume-as-host").click();
    await expect(hostPageB.getByTestId("theme-picker")).toBeVisible();

    await hostPageB.getByTestId("theme-option-club").click();
    await expectTheme(hostPageB, "club");
    await expectTheme(hostPage, "club");
    for (const player of players()) await expectTheme(player, "club");

    await hostPage.getByTestId("theme-option-rain").click();
    await expectTheme(hostPage, "rain");
    await expectTheme(hostPageB, "rain");
    for (const player of players()) await expectTheme(player, "rain");

    // There is no player theme control. Exercise the server authority through
    // the already-authenticated player socket and verify the skin does not
    // change; the rejection frame is the observable authority response.
    await expect(alice.getByTestId("theme-picker")).toHaveCount(0);
    await alice.evaluate(() => {
      const sockets = (globalThis as any).__openSockets as Set<{
        readyState: number;
        url: string;
        send: (data: string) => void;
      }>;
      // Vite's HMR socket is also open in dev. Only the room socket reaches
      // the GameRoom authority boundary under test.
      const socket = [...sockets].find(
        (candidate) => candidate.readyState === 1 && candidate.url.includes("/api/rooms/"),
      );
      if (!socket) throw new Error("No open player WebSocket");
      socket.send(JSON.stringify({ type: "set_visual_theme", visualTheme: "atelier" }));
    });
    await expect
      .poll(
        () => alice.evaluate(() => (globalThis as any).__rejectionCodes as string[]),
        { timeout: 5_000 },
      )
      .toContain("not_host");
    await expectTheme(alice, "rain");

    // Reload uses the canonical per-tab seat token and keeps the authoritative
    // room theme. Closing and opening a fresh tab exercises local backup
    // recovery on another tab/device-style session.
    await alice.reload();
    await expect(alice.getByTestId("player-list")).toContainText("Alice");
    await expectTheme(alice, "rain");

    await alice.close();
    alice = await aliceCtx.newPage();
    await alice.goto(`/room/${roomCode}`);
    await expect(alice.getByTestId("rejoin-backup")).toContainText("Rejoin as Alice");
    await alice.getByTestId("rejoin-backup").filter({ hasText: "Rejoin as Alice" }).click();
    await expect(alice.getByTestId("player-list")).toContainText("Alice");
    await expectTheme(alice, "rain");

    // Start a small, ordinary game through the visible host control. We let
    // the host force-advance an untouched night, then vote out the one mafia
    // in the 3-player suggested setup. This is enough to reach the real
    // rematch lobby without making the theme test a second full-game suite.
    await hostPage.getByTestId("start-game").click();
    await Promise.all(players().map((player) => waitForPhase(player, "night")));
    const roleTexts = await Promise.all(
      players().map(async (player) => {
        await expect(player.getByTestId("role-reveal-dialog")).toBeVisible({ timeout: 10_000 });
        return player.getByTestId("role-reveal-dialog").innerText();
      }),
    );
    const mafiaIndex = roleTexts.findIndex((text) => /\bMafia\b/i.test(text));
    expect(mafiaIndex).toBeGreaterThanOrEqual(0);
    const mafiaPage = players()[mafiaIndex]!;
    const mafiaName = ["Alice", "Bob", "Carol"][mafiaIndex]!;

    await hostPage.getByTestId("force-advance-button").click();
    await hostPage.getByTestId("force-advance-confirm-confirm").click();
    // The forced night must produce a real dawn beat. Dawn is also timed, so
    // allow it to advance naturally instead of requiring an acknowledgement
    // after the role-reveal dialog's five-second window has elapsed.
    await Promise.all(players().map((player) => waitForPhase(player, "dawn")));
    await Promise.all(players().map((player) => waitForPhase(player, "day")));
    await Promise.all(players().map((player) => waitForRoleRevealToClose(player)));

    for (const player of players()) {
      await player.getByTestId("vote-option").filter({ hasText: mafiaName }).click();
      await expect(player.getByTestId("confirm-vote-button")).toBeEnabled();
      await player.getByTestId("confirm-vote-button").click();
    }
    await expect(hostPage.getByTestId("host-winner-splash")).toBeVisible({ timeout: 25_000 });
    await expect(mafiaPage.getByTestId("winner-splash")).toBeVisible({ timeout: 25_000 });

    // Rematch returns every seat to the lobby while retaining the public room
    // theme. The picker is available again so the host can choose a new mood
    // between rounds, but no local optimistic skin is involved.
    await hostPage.getByTestId("new-game").click();
    await hostPage.getByTestId("new-game-confirm-confirm").click();
    await expect(hostPage.getByTestId("theme-picker")).toBeVisible({ timeout: 15_000 });
    await expect(hostPage.getByTestId("theme-option-rain")).toHaveAttribute("aria-pressed", "true");
    for (const player of players()) {
      await expect(player.getByTestId("player-list")).toBeVisible({ timeout: 15_000 });
      await expectTheme(player, "rain");
    }
  } finally {
    await closeContexts(contexts);
  }
});

test("same-room SPA re-entry resets the old skin before auth snapshot", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installWelcomeGate(page);

  try {
    const roomCode = await createRoomAsHost(page);
    await page.getByTestId("theme-option-club").click();
    await expect(page.getByTestId("theme-status")).toHaveAttribute("data-status", "saved");
    await expectTheme(page, "club");

    await spaNavigate(page, "/");
    await expect(page.getByTestId("create-room")).toBeVisible();

    await page.evaluate(() => {
      (globalThis as any).__holdRoomWelcome = true;
    });
    await spaNavigate(page, `/room/${roomCode}`);

    // The prior Zustand snapshot still contains this room and its Club skin,
    // but the new Room has not authenticated yet. App must show Atelier until
    // the held authoritative welcome is released.
    await expect
      .poll(() => page.evaluate(() => (globalThis as any).document.documentElement.dataset.visualTheme), { timeout: 2_000 })
      .toBe("atelier");

    await page.evaluate(() => {
      (globalThis as any).__holdRoomWelcome = false;
      const held = (globalThis as any).__heldRoomMessages as Array<() => void>;
      while (held.length > 0) held.shift()!();
    });
    await expectTheme(page, "club");
    await expect(page.getByTestId("theme-picker")).toBeVisible();
  } finally {
    await context.close();
  }
});
