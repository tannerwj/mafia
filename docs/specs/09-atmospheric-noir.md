# Spec 09 — Atmospheric noir visual system

**v1 — 2026-07-05 · Status: approved for build**
Parent: Tanner UI feedback (2026-07-05) — "looks janky, make it cleaner,
keep the noir palette and layout ideas; atmospheric noir direction." Depends
on: the shipped app (all specs 00–08). **Pure presentation change** — no
game logic, protocol, engine, or projection changes; no new data-testids
removed or renamed.

## Goal

Replace the ad-hoc, one-off styling (today there is exactly ONE real
primitive, `components/ui/button.tsx`; every card/list/pill/panel is a
bespoke `<div>` with slightly different padding/border/radius per screen)
with a single cohesive **shadcn/ui-based design system** themed to the
existing noir tokens, plus tasteful speakeasy atmosphere. Done looks like:
every screen draws from one spacing/type/surface vocabulary; a
screenshot tour of all screens reads as one polished app, not a dozen
hand-built pages; and the full existing test suite (32 E2E + unit) stays
green because no testid or behavior changed.

## Non-goals

Changing the color palette (keep ink/blood/brass/bone/smoke), layout
structure, copy, or ANY game behavior. New screens or features. Renaming or
removing `data-testid`s. External asset/CDN/font requests.

## Pinned conventions

### Hard constraints (violating any of these is a build failure)

- **Preserve every `data-testid` and every DOM role/label the tests query.**
  The suite (test/e2e/*, test/client/*) asserts on testids, button text, and
  attributes like `data-phase`, `data-consensus-reached`, `data-revealed`,
  `data-tint`. Restyle the *appearance*; keep the *contract*. A grep diff of
  testids before/after must be empty (net-zero: additions ok, no removals/
  renames).
- **Decorative layers MUST be `pointer-events: none`.** Any grain overlay,
  vignette, gradient wash, or full-bleed atmosphere element must never
  intercept taps. (This is the exact class of bug that made buttons
  unclickable before — verified by real-click in the gate.) Interactive
  elements keep `pointer-events: auto` and sit above decoration in z-order.
- **No external requests.** Grain/texture = an inline SVG-noise `data:` URI
  or a CSS-generated pattern, never a hosted image. Fonts stay the bundled
  `@fontsource-variable/playfair-display`. Grep gate: no `fonts.googleapis`,
  `cdn.`, `http(s)://…` asset refs in src/ or index.html.
- **Respect `prefers-reduced-motion`**: all motion/animation (fades, slides,
  grain shimmer) is disabled/reduced under the media query.
- **Preserve the Spec 04 transition contract**: latest snapshot wins,
  interruptible, ~300ms; `previousPhase` stays a UI-store concern. Phase
  ambiance may not block or delay rendering newer state.
- **Mobile-first 390×844**, ≥44px tap targets, safe-area insets, no
  horizontal scroll — all already pinned in Spec 04, keep them.

### Dependency budget (closed)

May ADD only the standard shadcn trio if not already present:
`class-variance-authority`, `clsx`, `tailwind-merge` (tiny, tree-shaken —
they power `cn()` and Button variants). shadcn components are **copied in**
(new-york style) under `components/ui/`, not installed as a package. No
other new runtime deps. Record final `package.json` deps in notes; the bundle
size delta must be flagged (cost-awareness).

### Design system

- **Surfaces & depth**: `ink` = app background; `ink-2` = card/panel;
  `ink-3` = raised/nested. Borders `smoke/40–60`. One elevation treatment
  (a soft, low, dark shadow) for cards that should lift; flat for inline
  rows. One radius scale (e.g. `rounded-lg` cards, `rounded-md` controls,
  `rounded-full` pills) applied consistently — no more per-screen radii.
- **Spacing**: one scale (Tailwind default). Cards `p-4`/`p-6`; consistent
  vertical rhythm (`gap-3`/`gap-4`/`gap-6`); page container `max-w-md`
  (players) / `max-w-3xl` (host), centered, consistent page padding.
- **Typography**: Playfair (`font-display`) reserved for *moments* — phase
  interstitial titles, role names, the win splash, screen H1s. Everything
  else the sans stack. Define a small type scale (display-xl / display-lg /
  title / body / label / caption) and use it, so sizes stop being ad hoc.
- **shadcn primitives to build** (`components/ui/`): `card` (Card/
  CardHeader/CardContent/CardFooter), `badge` (variants: role-town/
  role-mafia/role-neutral/neutral, using bone/blood/brass), `separator`,
  and expand `button` variants (brass primary, blood destructive, outline,
  ghost, size lg/default/icon). App components refactored to compose these:
  `PlayerRow`/player table, status pills (voted/acted/pending/asleep,
  alive/dead, connected/absent), phase header, the night-action target
  list, RoleReveal/MyRole card, Instructions.
- **Atmosphere (the "atmospheric" layer — tasteful, restrained)**:
  - A single global grain/texture overlay component (fixed, full-viewport,
    `pointer-events:none`, very low opacity ~3–6%, inline SVG noise),
    mounted once at app root behind content.
  - **Phase ambiance** via the existing `data-tint`/phase mechanism: night =
    cooler, deepest ink, subtle top-down vignette; day = warmer, `ink-2`
    surfaces with faint brass warmth; dawn/dusk interstitials = dramatic
    full-bleed centered Playfair over a soft radial gradient wash. All via
    CSS driven off the phase attribute already in the DOM — no new JS state
    beyond what Spec 04 established.
  - **Serif moments**: role reveal, phase interstitials, win splash get
    larger Playfair + a touch more space/drama (they're the emotional beats).
  - Motion: gentle fade/scale on card mount and dialog open (Radix/vaul
    already animate); a subtle brass pulse on "consensus reached"/"locked";
    all gated by reduced-motion.

## Deliverables

- **D1 — foundation**: `cn()` on clsx+tailwind-merge (replace the hand-rolled
  one if simpler), the shadcn primitives above, expanded Button variants,
  the grain overlay at app root, phase-ambiance CSS keyed off the existing
  phase attribute. Update `index.css` `@theme` only additively (new
  semantic tokens like shadow, radius if useful — don't change palette).
- **D2 — apply across every screen** (compose the primitives, delete the
  bespoke divs): Home, Lobby (player), HostLobby, RoleReveal, MyRoleButton
  dialog, HelpButton, Instructions, NightActionDrawer (+ mafia teammate-pick
  list, minion panel, detective/angel panels, idle "town sleeps"),
  Dawn/Dusk interstitials, Day/Voting grid (+ runoff, no-murder card,
  investigation/roster panels), DeadGodView, GameEnd, HostGame (PlayerTable,
  PhaseHeader, DeadlineCountdown, HostLog, controls), ConnectionBanner,
  ManualShareLink, IdentityChooser. Every screen uses the shared vocabulary.
- **D3 — tests/verification hooks**: existing suites must pass UNCHANGED
  (that's the behavior-preservation proof). Add at most light structural
  tests if a new shared component warrants it. A testid-diff check
  (before/after) shows no removals.

## Acceptance criteria

CI: typecheck clean; engine/client/server unit suites unchanged & green;
**all 32 E2E tests green with no test edits** (if an E2E test needs editing
to pass, that means appearance leaked into the contract — stop and justify);
grep gates: no external asset/CDN refs; `pointer-events:none` present on
every decorative overlay; testid set is a superset of the pre-restyle set.
Bundle size delta recorded.
Live (orchestrator): full screenshot tour of EVERY screen at 390×844 (+ host
at 1024) for design review; real-click every primary control on every screen
(create, join, share, start, pick target, lock in, vote, my-role, help,
force-advance) to prove no decorative layer eats taps; a full game played
through the restyled UI end to end.

## Notes for implementer

- This is appearance only. If you feel tempted to change behavior, copy, or a
  testid to make styling easier — don't; restructure the CSS/markup instead.
- Reuse `roleCopy.ts`, the phase attribute, the store — don't add state.
- Screenshot your own work as you go; cohesion is the goal, so check screens
  side by side, not in isolation.
- Deviations → `docs/specs/09-implementation-notes.md`, end with a STATUS
  line. Do not commit or deploy (orchestrator owns those).
