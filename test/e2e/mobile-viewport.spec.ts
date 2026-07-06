import { expect, test, type Locator, type Page } from "@playwright/test";

// Spec 18: the no-horizontal-overflow invariant at a real phone viewport.
// This is a LAYOUT smoke test, not a game-logic test — it walks the same
// landing -> create -> join x3 -> start -> night path other specs already
// cover functionally (see game.spec.ts), asserting only two cheap, honest
// facts on every screen along the way:
//   1. `document.documentElement.scrollWidth` never exceeds the viewport
//      width (360px) -- nothing overflows horizontally, forcing a scrollbar.
//   2. the visible page container's computed `padding-left` is >= 16px --
//      the Spec 18 root-cause regression (safe-area utilities silently
//      zeroing Tailwind padding at phone widths) would show 0px here.
//
// `test/e2e` type-checks under `tsconfig.node.json` (no DOM lib — shared with
// `test/engine`), so `page.evaluate`/`locator.evaluate` callback bodies can't
// reference bare `document`/`getComputedStyle` globals. Playwright's own
// typings give the `evaluate` callback's `el` parameter a real DOM element
// type independent of `lib`, so reading `el.scrollWidth` / calling a method
// on `el.ownerDocument`'s `defaultView` works without widening `lib` for the
// whole project.
test.use({ viewport: { width: 360, height: 740 } });

const VIEWPORT_WIDTH = 360;
const MIN_PADDING_PX = 16; // 1rem at the default 16px root font size

async function expectNoHorizontalOverflow(page: Page) {
  const scrollWidth = await page.locator("html").evaluate((el) => el.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(VIEWPORT_WIDTH);
}

// `locator.evaluate` grabs whatever the locator resolves to AT THAT INSTANT —
// unlike `expect(locator)` matchers, it does not auto-wait/retry. Two
// failure modes that requires guarding against:
//   1. A bare `main` locator can transiently match the WRONG `<main>` (e.g.
//      Room.tsx's connecting/"Opening the file…" placeholder main, which
//      carries no page padding by design) in the instant right after a
//      preceding assertion resolves but before the real screen has fully
//      swapped in. Callers must pass a locator anchored to a stable testid
//      that only exists on the intended screen (`.filter({ has: ... })` or a
//      direct `getByTestId` on the padded element itself), never a bare
//      tag-name locator.
//   2. Even correctly anchored, a fresh render can read 0 for one frame
//      before layout settles. `expect.poll` retries the read until it
//      clears the minimum (or the timeout elapses), so a one-shot
//      mid-transition sample can't fail an otherwise-correct screen.
async function expectMinLeftPadding(locator: Locator) {
  await expect
    .poll(
      () =>
        locator.evaluate((el) => {
          const view = el.ownerDocument.defaultView;
          if (!view) return 0;
          return parseFloat(view.getComputedStyle(el).paddingLeft);
        }),
      { timeout: 5_000 },
    )
    .toBeGreaterThanOrEqual(MIN_PADDING_PX);
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

async function waitForPhase(page: Page, phase: string, timeout = 25_000) {
  await expect(page.getByTestId("game-screen")).toHaveAttribute("data-phase", phase, {
    timeout,
  });
}

test.describe("Spec 18: no horizontal overflow at 360px", () => {
  test("landing -> host lobby -> 3 players join -> start -> night drawer", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const carolCtx = await browser.newContext();

    const hostPage = await hostCtx.newPage();

    // Landing.
    await hostPage.goto("/");
    await expectNoHorizontalOverflow(hostPage);

    // Host lobby (the spec's primary evidence screen: title/stamp/chip
    // header + share row + role-count editor all had to become
    // wrap-friendly once real padding was restored).
    await hostPage.getByTestId("create-room").click();
    await expect(hostPage).toHaveURL(/\/room\/[A-Z0-9]{5}$/);
    const roomCode = hostPage.url().split("/room/")[1]!;
    await expect(hostPage.getByTestId("role-count-editor")).toBeVisible();
    await expectNoHorizontalOverflow(hostPage);
    // Anchored to the host-lobby `<main>` specifically (via a testid that
    // only exists on that screen) — a bare `main` locator can transiently
    // resolve to Room.tsx's unpadded "Opening the file…" connecting
    // placeholder in the instant before the real lobby swaps in.
    await expectMinLeftPadding(
      hostPage.locator("main").filter({ has: hostPage.getByTestId("role-count-editor") }),
    );

    // 3 players join — each lands on the player lobby/roster screen.
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    const carol = await carolCtx.newPage();
    await joinAsPlayer(alice, roomCode, "Alice");
    await expectNoHorizontalOverflow(alice);
    // Anchored to the player-lobby `<main>` via `player-list` (present only
    // once the roster screen has actually mounted) for the same reason as
    // the host-lobby check above.
    await expectMinLeftPadding(
      alice.locator("main").filter({ has: alice.getByTestId("player-list") }),
    );
    await joinAsPlayer(bob, roomCode, "Bob");
    await expectNoHorizontalOverflow(bob);
    await joinAsPlayer(carol, roomCode, "Carol");
    await expectNoHorizontalOverflow(carol);

    // Host lobby with a full roster (SUBJECT DOSSIERS / role-count editor /
    // QR row all visible at once — the densest pre-game screen).
    await expect(hostPage.getByTestId("host-player-table")).toBeVisible();
    await expectNoHorizontalOverflow(hostPage);

    // Start the game (house ruleset — 3 players is the minimum legal table).
    await hostPage.getByTestId("start-game").click();

    // Host case board (in-game): header + phase card + subject dossiers +
    // narrator board / controls drawer.
    await expect(hostPage.getByTestId("host-phase-label")).toBeVisible({ timeout: 25_000 });
    await expectNoHorizontalOverflow(hostPage);
    // Anchored to the host case-board `<main>` via `host-phase-label`, same
    // reasoning as the two anchors above.
    await expectMinLeftPadding(
      hostPage.locator("main").filter({ has: hostPage.getByTestId("host-phase-label") }),
    );

    // Players reach the night screen (role reveal dialog, then either the
    // night action drawer or the decoy "keep watch" drawer).
    await waitForPhase(alice, "night");
    await waitForPhase(bob, "night");
    await waitForPhase(carol, "night");
    for (const p of [alice, bob, carol]) {
      await expectNoHorizontalOverflow(p);
    }

    // Dismiss the auto-dismissing role reveal (or wait it out) before
    // asserting on the drawer underneath — same pattern as game.spec.ts.
    await expect(alice.getByTestId("role-reveal-dialog")).toHaveCount(0, { timeout: 15_000 });
    await expectNoHorizontalOverflow(alice);
    const drawer = alice.getByTestId("night-action-drawer");
    if (await drawer.isVisible().catch(() => false)) {
      await expectMinLeftPadding(drawer);
    }
  });
});
