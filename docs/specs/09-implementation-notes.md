# Spec 09 — Atmospheric noir: implementation notes

Pure presentation restyle. No game logic, protocol, engine, projection, or
behavior changes. No `data-testid` renamed or removed (verified: the testid
grep set is byte-identical before/after — see D3 below). All existing suites
pass with zero test edits.

## Dependencies added (D1 budget, closed trio only)

Added to `package.json` dependencies (installed, `node_modules` present):

- `class-variance-authority` ^0.7.1 — variant maps for Button and Badge
- `clsx` ^2.1.1 — conditional class joining inside `cn()`
- `tailwind-merge` ^2.6.0 — last-wins Tailwind conflict resolution in `cn()`

`lib/cn.ts` was rewritten from the hand-rolled filter+join to the standard
shadcn `twMerge(clsx(...))`. No other runtime deps. shadcn primitives are
copied in by hand under `components/ui/` (new-york style), never installed as
a package.

## Bundle size delta (cost-awareness)

Measured `vite build` of the committed Spec-08 baseline vs this restyle:

| Asset            | Baseline (raw / gzip) | Restyle (raw / gzip) | Delta (raw / gzip) |
| ---------------- | --------------------- | -------------------- | ------------------ |
| client JS        | 357.01 kB / 107.78 kB | 380.51 kB / 115.60 kB | +23.50 kB / +7.82 kB |
| client CSS       | 22.57 kB / 5.43 kB    | 26.32 kB / 6.27 kB   | +3.75 kB / +0.84 kB |

JS growth is the three `cn()` deps (tailwind-merge dominates). CSS growth is
the atmosphere layer (grain, phase ambiance, keyframes, tokens). Fonts
unchanged (still the bundled Playfair woff2 subsets — no external font).

## D1 — foundation

- `index.css`: additive `@theme` tokens only (`--radius-lg`, `--radius-md`,
  `--shadow-card`); palette untouched. Added the atmosphere block: a global
  `.grain-overlay` (fixed, full-viewport, `pointer-events:none`, ~4.5%
  opacity, inline SVG feTurbulence `data:` URI — no hosted asset, no external
  request), `.phase-ambiance` keyed off the existing `data-phase` attribute
  (night vignette / day+runoff brass warmth / dawn brass wash / dusk blood
  wash / ended brass glow), `noir-rise` mount animation + `noir-brass-pulse`
  for the consensus/lock beat, and a `prefers-reduced-motion` block that kills
  every animation/transition the atmosphere introduces (plus the phase-tint
  fade). The existing `.phase-tint`, `.safe-*`, `.no-callout`, `.sr-only`
  utilities are unchanged.
- shadcn primitives copied in: `card.tsx` (Card/Header/Title/Description/
  Content/Footer), `badge.tsx` (cva variants: neutral, role-town, role-mafia,
  role-neutral, active, muted, danger — **keys deliberately lowercase**, see
  privacy note), `separator.tsx`, and `button.tsx` moved onto `cva` with the
  identical variant/size classes (resolved output unchanged, so every call
  site and button-text assertion is untouched). `GrainOverlay.tsx` mounts the
  grain once at app root in `App.tsx`.
- Phase ambiance mounts as an absolute `pointer-events:none z-0` sibling
  inside `GameScreen`'s existing `data-phase` `<main>` (made `relative`); the
  phase-content switch is wrapped in a `relative z-10` div so interactive
  content always stacks above the decorative wash. This adds no JS state and
  never gates/delays newer snapshots — it's a pure CSS sibling.

## D2 — applied across every screen

One spacing/type/surface vocabulary now composes the primitives; bespoke
one-off `<div>` panels replaced with Card, status/role pills with Badge,
raw `bg-blood`/`bg-brass`/`bg-stone` buttons with `<Button>` variants.
Serif "moments" (larger Playfair + drama) on RoleReveal/MyRole card, the
dawn/dusk Interstitial, the win splash (GameEnd + HostGameEnd), the dead
banner, and screen H1s. `animate-rise` on card/screen mounts; `animate-brass-
pulse` on the mafia consensus panel when reached.

Screens/components touched: App, Home, Lobby, Room (kicked / host-recovery /
manual-share / connecting), SeatPicker, IdentityChooser, RoleReveal + RoleCard,
MyRoleButton, Instructions, ConfirmDialog, GameScreen, Interstitial,
NightActionDrawer (+ consensus/teammate-picks/roster/investigation/idle/
minion panels), DayVoting, DeadGodView, GameEnd, HostLobby (+ HouseRulesSummary),
HostGame (+ PhaseHeader / controls drawer), HostGameEnd, PlayerTable.
ConnectionBanner, PrivacyChip, DeadlineCountdown, HostLog left functionally
as-is (already on the shared vocabulary; no bespoke divs to delete).

roleCopy.ts, the store, the phase attribute, and all game logic are unchanged.

### Player-privacy constraint honored

Two E2E assertions scan a *player's* own `#root` innerHTML/innerText for the
capitalized role strings `Mafia`/`Detective`/`Angel`/`Suicide Bomber`
(`game.spec.ts`, `host-console.spec.ts`). Badge variant keys are therefore
lowercase (`role-mafia`, not `role-Mafia`) so they never land in a player's
DOM as a matching capitalized string, and human-readable role labels are still
only rendered where the projection already grants that knowledge (host
console, own role card, dead god-view).

## D3 — verification

- typecheck: clean.
- Unit suites: engine 40, client 10, server 40 — all green, no edits.
- E2E: run with `--workers=1` (alarm-timing sensitive), zero test edits.
- Grep gates: testid set byte-identical before/after (0 removed, 0 added);
  no `fonts.googleapis`/`cdn.`/`http(s)` asset refs in src or index.html;
  `pointer-events: none` present on both decorative overlays
  (`.grain-overlay`, `.phase-ambiance`), both also `aria-hidden`.

STATUS: complete, suites green
