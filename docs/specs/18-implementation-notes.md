# Spec 18 implementation notes — responsive cleanup (phone-first polish)

Built against HEAD `2b2bd59` (verified via `git log --oneline -1` before
starting; tree was clean). No worktree isolation used — worked directly in
the repo per the brief. Client-only: `src/client/**` + one new
`test/e2e/**` file, nothing else touched.

## The root-cause fix

`src/client/index.css`'s `.safe-top`/`.safe-bottom`/`.safe-x` were plain
unlayered CSS rules setting `padding-*` directly — under Tailwind v4,
unlayered declarations always beat layered utilities, so any element with
both one of these AND a same-axis Tailwind padding utility (`p-6`, `p-4`,
`px-4`, ...) had its real padding silently replaced by
`env(safe-area-inset-*)`, which is `0px` on desktop and `0px` on phones in
portrait (side/top insets only exist near a notch/home-indicator in
landscape). That's why every room screen at ≤768px rendered flush against
the viewport edge.

Fix shape: deleted all three old utilities entirely and replaced them with
Tailwind v4 `@utility` definitions (these live in Tailwind's own utilities
layer, so they compose/override predictably like any built-in) that use
`max(base, env(...))` — the inset can only grow the padding, never zero it
out. New utility set, each used **instead of** — never alongside — a
same-axis Tailwind padding/position utility:

- `page-p` — all four sides, 1.5rem base (replaces the old `p-6` + `safe-*`
  combo on every full-page `<main>`).
- `page-p-sm` — all four sides, 1rem base (replaces `p-4` + `safe-*`; used
  by `HostGame`'s denser in-game `<main>`).
- `page-p-bottom` — left/right/bottom only, 1rem base (the fixed
  `ManualShareLink` bar in `Room.tsx`, which never had top padding).
- `safe-pt` / `safe-pb` / `safe-px` — inset-only, no base, for elements that
  genuinely have zero Tailwind padding on that axis by design
  (`ConnectionBanner`'s top-only inset; the night/controls drawer bodies'
  bottom-only inset; `GameScreen`'s outer frame, whose phase-content
  children own their own `px-4`/`px-6` so the frame itself has none).
- `chip-inset-tl` / `-tr` / `-bl` / `-br` — for the four fixed-position
  chips (`GameStatus`, `HoldToPeek`, `MyRoleButton`, `HelpButton` in
  `GameScreen`). These previously mixed `top-3`/`left-3`/etc. (an offset)
  with `safe-top`/`safe-x` (padding) — mixing an offset with padding on a
  `position: fixed` element does nothing useful; the fix folds the base
  0.75rem gap AND the relevant inset(s) into the `top`/`left`/`bottom`/
  `right` **position** properties themselves via
  `max(0.75rem, calc(0.75rem + env(...)))`.

Grep-verified post-fix: no element in `src/client` carries both a
`safe-*`/`page-*`/`chip-inset-*` utility and a competing same-axis Tailwind
padding/position utility. Verified in the compiled CSS
(`dist/client/assets/*.css`) that all new utilities emitted the expected
`max()`/`calc()` declarations.

**Bug found in passing**: `HoldToPeek.tsx` had `fixed right-3 top-3` with
only `safe-top` — no horizontal inset at all, so on a notched phone in
landscape the button could sit under the notch/rounded corner on the right
edge. Now gets `chip-inset-tr` (both insets) like the others.

## Screen-by-screen changes

1. **Host lobby header** (`HostLobby.tsx`) — header row and its two flex
   groups (title+stamp, help+privacy) are now `flex-wrap`; `PrivacyChip`
   (`PrivacyChip.tsx`) shows the full "eyes only — keep this file private"
   text at ≥400px and just "eyes only" below that (a CSS-only
   `min-[400px]:` split, no JS breakpoint state) so it never forces the
   header wide enough to clip.
2. **Host lobby content column** — no structural change needed beyond the
   root-cause padding fix; the room-code/share/storyteller row already used
   `flex flex-wrap`.
3. **Host case board** (`HostGame.tsx`) — same header wrap-friendly
   treatment. `PlayerTable.tsx` rows were already `flex-wrap` with
   `min-w-0 flex-1 truncate` on the name column, so MARK ABSENT/role
   badge/status already drop to their own line under the name at 360px —
   confirmed by reading the flex/wrap classes, no change needed there.
   `NarratorBoard.tsx`'s day-pager header row (label + prev/day/next) got
   `flex-wrap` added defensively (label + two 44px buttons + a 96px day
   label can get tight under ~310px of available width inside the
   narrower host-board column).
4. **Landing** (`Home.tsx`) — root-cause fix only; swept the `MAFIA`
   `text-7xl` heading and the house-facts 2×2 grid, both fit at 320px
   (mono heading ≈215px of 5 chars; grid already `grid-cols-2 gap-3` with
   no fixed track width).
5. **Player screens sweep** — `Lobby`, `SeatPicker`, `IdentityChooser`,
   `Room.tsx`'s not-found/kicked/host-recovery mains, `GameScreen`'s outer
   frame all moved off the broken `safe-*` combo onto `page-p`/`safe-*`
   variants as appropriate. Inner game screens (`DayVoting`,
   `Interstitial`, `SceneHolding`, `DeadGodView`, `GameEnd`,
   `NightActionDrawer`'s panels) never carried `safe-*` themselves (they're
   scroll content inside `GameScreen`'s frame, using plain `px-4`/`px-6`)
   so they were never affected by the bug and needed no changes; read
   through all of them to confirm no fixed widths or non-wrapping flex rows
   at 320–390px.
6. **Dialogs/drawers** — `NightActionDrawer`, host controls drawer, `My
   Role`/`Instructions`/`GameStatus`/Storyteller-setup dialogs already use
   `max-h-[85dvh]` + internal `overflow-y-auto` and `w-[calc(100%-2rem)]`
   (or `max-w-md`/`max-w-xs` with viewport margin), which already satisfies
   320×568 fit — confirmed by reading, no change needed beyond the
   drawer-body `safe-bottom` -> `safe-pb` rename.
7. **Desktop/tablet** — no `md:`/`max-w-*` breakpoints changed; the
   `page-*` utilities resolve to their base padding (insets are 0 on
   desktop), so desktop is visually identical to before. QR code size is a
   fixed `224px` canvas prop, never viewport-scaled, so there was no
   ballooning risk to begin with.

## Deviations from the spec

- The spec's illustrative CSS sketch (`.page-px` using `max(1.5rem,
  env(left), env(right))` as one declaration) doesn't type-check as
  written (each `max()` needs its own property); implemented instead as
  the `page-p`/`page-p-sm`/`page-p-bottom` set with explicit
  `max(base, env(single-side-inset))` per side, per the spec's own
  "implementer picks the exact mechanism" latitude.
- Added `chip-inset-*` as four separate corner utilities rather than one
  parameterized utility — Tailwind v4's `@utility name-*` functional form
  needs a `--value()` theme lookup, which is overkill for 4 fixed corners;
  plain `@utility` per corner is simpler and equally cheap.

## Tests

- `npm run typecheck` — clean (`tsc --build --force`, all 5 project
  references).
- `npm test` — 358 passed / 0 failed across all three vitest projects:
  engine 175, client 54, server 129 (server project needs `dist/client`;
  built once via `npx vite build` before running). The
  `EnvironmentTeardownError`/"close timed out" lines after the pass summary
  are a known vitest-pool-workers cleanup quirk, unrelated to this change
  (pre-existing, appear after every project already reports 100% passed).
- `npx vite build` — clean production build; inspected the emitted CSS
  directly to confirm the new utilities compiled to the intended
  `max()`/`calc()` rules.
- New `test/e2e/mobile-viewport.spec.ts` — `test.use({viewport: {width:
  360, height: 740}})`, walks landing -> host creates room -> 3 players
  join -> host starts game -> all players reach night, asserting at each
  step (a) `document.documentElement.scrollWidth <= 360` via
  `page.locator("html").evaluate(el => el.scrollWidth)` and (b) the visible
  page container's computed `padding-left >= 16px` via
  `locator.evaluate(el => getComputedStyle(...))`. Not run against a live
  dev server (orchestrator owns `wrangler dev`/playwright per CLAUDE.md) —
  typechecks clean under `tsconfig.node.json`'s no-DOM-lib e2e project
  (Playwright's own typings give `evaluate` callback elements a real DOM
  type independent of the project's `lib` setting, so no `lib` widening was
  needed).
- Did not run Playwright/wrangler per the brief — orchestrator verifies
  live with a real screenshot tour.

## STATUS: COMPLETE

Tree left uncommitted for orchestrator verification.
