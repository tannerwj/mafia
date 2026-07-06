# Spec 18 — Responsive cleanup (phone-first polish)

**v1 — 2026-07-06 · Status: approved for build (Tanner: "the page looks a
little jumbled at phone-sized resolution — make the site nice and
responsive across all useful resolutions"). Builds AFTER Spec 17 lands
(client-file serialization).**
Tier: light (client-only CSS/layout; no engine/protocol/server; delegated +
verified with a real mobile-viewport tour; no review round). Evidence:
orchestrator screenshots at 360×740 in `.claude-scratch/resp/` (gitignored).

## ROOT CAUSE (fix this first — it's most of the "jumble")

`src/client/index.css:339` defines `.safe-x { padding-left:
env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }`
as **unlayered** CSS. Under Tailwind v4, unlayered declarations beat every
layered utility — so on any element with BOTH `safe-x` and `p-6`/`px-*`
(Home, HostLobby, HostGame, GameScreen mains; MyRoleButton; GameStatus
chip; HelpButton), horizontal padding is silently overridden to
`env(safe-area-inset-*)`, which is **0 on desktop AND 0 on phones in
portrait** (side insets only exist in landscape/notch-side). Result: at
<768px, room screens render content flush against the viewport edges
(evidence: hostlobby-360-full.png — title at x=0, EYES-ONLY chip clipped
off-screen, full-bleed buttons). Desktop hid it via `max-w-* mx-auto`
centering margins.

**Required fix shape:** safe-area insets must ADD to base padding, never
replace it. Preferred: replace the three utilities with Tailwind v4
`@utility` definitions that compose, e.g. `padding-left: calc(
env(safe-area-inset-left, 0px) + var(--sx, 0px))` is NOT enough by itself —
the clean pattern is dedicated combined utilities used by the page mains:
`.page-px { padding-inline: max(1.5rem, env(safe-area-inset-left),
env(safe-area-inset-right)); }` for page containers, while fixed chips
(MyRoleButton/GameStatus/HelpButton) get their own small combined utility
(base 0.75-1rem + inset). Implementer picks the exact mechanism, but the
acceptance is behavioral: every screen keeps ≥1rem horizontal padding at
every width with insets stacking on top, and no Tailwind px-*/p-* is
silently dead anywhere. Grep-verify: no element carries both `safe-x` and
a horizontal padding utility after the change (delete `.safe-x` entirely
if nothing legitimate remains).

## Screen-by-screen findings (fix + sweep)

Evidence at 360×740 unless noted:

1. **Host lobby header** (`HostLobby.tsx` header row): "LEAD INVESTIGATOR /
   THE CASE ROOM" wraps mid-title UNDER the CONFIDENTIAL stamp; the
   EYES-ONLY privacy chip overflows past the right viewport edge (clipped).
   Fix: header becomes wrap-friendly — title block + stamp on one row that
   wraps as a unit, chip row allowed to wrap below on narrow widths
   (`flex-wrap`), chip text truncates or shortens (e.g. just the lock +
   "EYES ONLY" under 400px). Nothing may overflow the viewport at 320px.
2. **Host lobby content column**: room-code tile + SHARE LINK +
   STORYTELLER buttons currently ragged after the padding fix — verify
   they wrap into tidy rows at 320/360/390 (share row: code tile grows,
   buttons wrap under it).
3. **Host case board (in-game, `HostGame.tsx`)**: same header pattern —
   same fix; SUBJECT DOSSIERS rows must not overflow (role labels + acted
   column + MARK ABSENT at 360 — allow the button to drop under the name
   row or use an icon-width button at <400px). Narrator board day-pager
   row must wrap.
4. **Landing (`Home.tsx`)**: broadly fine at 360 (evidence:
   landing-360-full.png). Sweep only: hero spacing at ≤320, HOUSE FACTS
   2×2 grid gap at 320, cast rows.
5. **Player screens sweep** (join/register, player lobby + roster card,
   role reveal, night drawers, day vote grid + confirm bar, morning
   report/interstitials, scene hold screens, game status panel, end
   screen, Storyteller panels host-side): the padding root-cause fix
   changes ALL of them — tour each at 320/360/390/768 and fix anything
   overflowing, overlapping, or edge-flush. Day vote grid: verify tap
   targets stay ≥44px and the grid reflows (2-col at ≤360 if needed).
6. **Dialogs/drawers** (role reveal, night action, storyteller setup,
   instructions): must fit 320×568 (small SE-class) without clipped
   buttons; internal scroll if content exceeds viewport height.
7. **Desktop/tablet (768/1024/1280)**: no regressions; the max-w-*
   centering stays; QR tile shouldn't balloon on desktop (cap its size).

## Acceptance

- No horizontal scrollbar / no content overflow at 320, 360, 390, 414,
  768, 1024, 1280 on: landing, join, host lobby, player lobby, host board
  (night + day), player night drawer, day vote, game status, end screen.
- All page containers keep ≥1rem horizontal padding at every width.
- Existing E2E stays green (testids untouched). New E2E: one mobile-
  viewport smoke test project entry or test.use({viewport 360×740}) spec
  that walks landing → create → join ×3 → start → night, asserting
  `document.documentElement.scrollWidth <= 360` on each screen (the
  no-horizontal-overflow invariant, cheap and honest).
- Orchestrator verify: scripted screenshot tour at the widths above +
  visual review before commit.

## Non-goals

Visual redesign (Case File identity unchanged); landscape-specific
layouts; print styles; a11y pass (separate); Lighthouse items (separate).
