# Spec 04 — Player UI (noir)

**v2 — 2026-07-04 · Status: approved for build**
*v2 folds in all findings from Codex adversarial review (2026-07-04):
projection contract holes closed via Spec 02 v2.2 (mafia factionVotes,
investigationResults shape, own pendingAction, no night pending-count) and
Spec 03 v2.1 (env-gated test seed); dependency budget corrected to scoped
Radix package; shadcn source pinned; transition-state ownership pinned;
HoldToPeek a11y fallback added; dependency check made mechanical. No
findings overruled.*
Parent: PLAN.md (art direction decision 2026-07-04). Depends on: Specs 01–03
(protocol, engine views, composed snapshots). Player-facing only.

## Goal

The phone-in-hand experience: a noir/speakeasy interface where a player can
join, learn their role privately, act at night, vote by day, die with
dignity (god view), and never think about connectivity. Done looks like: a
Playwright multi-context suite plays a complete 5-player house-rules game
through the real UI (1 host driving via the still-unstyled host controls +
4 players via this spec's screens), and DevTools mobile-viewport screenshots
of every screen pass the orchestrator's design review.

## Non-goals

Host console (Spec 05 — host keeps Spec 01's functional screens; do not
restyle them here). Ruleset editor (Spec 06). PWA/wake-lock/sound (Spec 07).
New game mechanics of any kind.

## Pinned conventions

- **Theme tokens** (Tailwind v4 `@theme`, single source):
  `--color-ink: #0c0a09` (bg), `--color-blood: #991b1b` (primary action /
  mafia accents), `--color-brass: #ca8a04` (highlights, win states),
  `--color-bone: #e7e5e4` (body text), `--color-smoke: #44403c` (borders,
  muted), plus derived surfaces (`ink-2` #1c1917, `ink-3` #292524).
  Dark always — this app is used in dim party rooms; there is no light mode.
  Phase tinting: night screens cool (pure ink), day screens warm (`ink-2`
  surfaces + brass emphasis); transition = 300ms fade through black.
- **Type**: display serif for headings/role names — self-hosted woff2 via
  `@fontsource-variable/playfair-display` (bundled asset; NO external font
  or CDN requests anywhere); body = system sans stack. Type scale: display
  only for role reveal + phase titles; everything else sans.
- **Dependency budget (exact, closed list)**: `zustand`,
  `@fontsource-variable/playfair-display`, `@radix-ui/react-dialog` (the
  scoped package — NOT the unified `radix-ui` bundle: `vaul` depends on the
  scoped one, and two Radix Dialog implementations must not ship), `vaul`
  (bottom drawer), `sonner` (toasts), and the shadcn `Button`/`cn` pattern
  copied in from `npx shadcn@latest add button` (new-york style), license
  headers kept, recorded with CLI version in implementation notes.
  Nothing else without an implementation-notes justification.
- **Architecture**: one zustand store, hydrated exclusively by
  `RoomConnection` events (`welcome`/`snapshot`/`rejection`/`error`/status).
  Screens are pure renders of the store; every user intent is a protocol
  message; no derived game logic client-side beyond display formatting
  (the engine's projection already decided what this viewer may know).
- **Mobile-first, phone-locked layout**: design at 390×844, must work
  360–430 widths; ≥44px tap targets; bottom-sheet (vaul) for all
  target-selection actions (thumb reach); safe-area-inset padding; no
  horizontal scroll ever; desktop gets the phone layout centered, max-w-md.
- **Player names are text nodes, never HTML** (standing rule).
- **Role privacy interaction**: role is shown once at assignment (Dialog,
  auto-dismiss 5s) then hidden behind **press-and-hold to peek** (design.md
  requirement): a "🎭 hold to see your role" affordance that reveals while
  pressed — releases hide it instantly. No toggle that can be left open on
  a table. Implementation pins: pointer events (not touch events) with
  pointer capture; `touch-action: none`, `-webkit-touch-callout: none`,
  `user-select: none` on the affordance (iOS long-press magnifier/callout
  would otherwise defeat it). **Accessibility fallback**: the affordance is
  a real `<button>`; keyboard/AT activation (Enter/Space/double-tap) gives a
  timed reveal (3s, `aria-live` announced) — hold-to-peek is an enhancement,
  not the only path.
- **Connection status**: a persistent thin banner slot — hidden when
  healthy, "Reconnecting…" (smoke) on drop, "Back" (brass, 2s) on recovery.
  Joining/rejoin/seat-picker flows per Spec 01 D4/D5 semantics, restyled.
- **Vote affordances**: voting is *changeable until dusk* — the UI always
  shows your current vote and lets you change it (no confirm-lock);
  `no_murder` ("Spare the town" styled distinctly) appears per ruleset;
  tallies render only what the projection contains (hidden mode: "N of M
  have voted" only).
- **Waiting states are first-class**: every phase has a "you're done,
  waiting on others" state, rendered strictly from Spec 02 v2.2's pinned
  fields: night non-actors get a static "the town sleeps"; night actors get
  own-submission state (`you.pendingAction`) — never a pending-count (the
  projection deliberately has none); mafia additionally render
  `factionVotes` + `consensusReached`; day voting renders "N of M voted"
  from the projection's tally-count field. Restored on reconnect from the
  same fields.
- **Transitions**: the phase fade needs previous-phase memory — that is
  presentation state, owned by a UI-only store slot (`previousPhase`); the
  "no game logic client-side" rule is not "no UI state". Pinned: the latest
  snapshot always wins immediately — transitions are interruptible and
  never queue or delay rendering of newer state.

## Deliverables

**D1 — theme**: tokens above wired into Tailwind `@theme`; base styles;
phase-tint mechanism; Playfair asset pipeline.

**D2 — screens** (each a store-driven component; listed with its key
states): Home (create/join), Lobby (restyled: presence dots, share/copy,
seat-picker per Spec 01), RoleReveal dialog + HoldToPeek, Night (role-gated
action drawer: mafia target+partner votes+consensus state; detective
target+results history; angel target incl. self; villager/minion/bomber
"the town sleeps" idle state; minion sees mafia list), Dawn/Dusk
announcement interstitials (log events, big serif), Day+Voting (grid of
living players + no_murder card, current vote highlight, change-vote,
runoff variant with only tied candidates), Dead god view (banner "you are
dead" + full roles list + resolved history; NO pending-submission data —
the projection already enforces this, the UI must not invent placeholders
for it), GameEnd (winner splash in brass, full role reveal table,
"waiting for host" state), plus the connection banner.

**D3 — store + wiring**: zustand store (`connection`, `you`, `room`,
`game`, `toasts`); RoomConnection event → store reducers; intent helpers
(`submitAction`, `castVote`…) that send protocol messages and surface
`rejection{code}` as toasts.

**D4 — tests**:
- Playwright multi-context full game (the Spec 03 fallback promise lands
  here): host (functional screens) + 4 player contexts; house rules, no
  timers; **deterministic via Spec 03 v2.1's env-gated `start_game.seed`**
  (dev server sets `ALLOW_TEST_SEED`) + fixed join order — each scenario
  documents its derived role assignment in the test file. Script: roles
  received → mafia converge on a kill → angel saves → dawn shows "attack
  failed" (derived client-side from `attackAttempted{outcome:'failed'}` —
  display formatting, not a new event concept) → vote with a runoff →
  suicide-bomber loss variant in a second scenario (different seed) →
  village win in a third. Assertions on user-visible text/roles per context
  (e.g. villager context NEVER renders another living player's role string —
  DOM-level privacy assertion).
- Reconnect UX: kill a player context's network mid-night → banner appears;
  restore → same seat, same pending action state, banner clears.
- Two tabs, one browser context → two seats (regression from Spec 01).
- Component-level: HoldToPeek (role visible only while pressed), vote
  change re-renders highlight, hidden-mode tally shows counts not names.

## Acceptance criteria

CI: D4 green; typecheck; dependency check is mechanical:
`jq -r '.dependencies|keys[]' package.json` equals exactly
`react react-dom zustand @radix-ui/react-dialog vaul sonner
@fontsource-variable/playfair-display` (sorted); `grep -r
"fonts.googleapis\|fonts.gstatic\|cdn\." src/ index.html` → no hits.
Implementation notes must record the bundled Playfair woff2 size (cost
flagging).
Live (orchestrator): DevTools mobile-viewport (390×844) screenshot pass of
every D2 screen in a real game; design review against the noir tokens;
multi-tab full game on localhost.

## Notes for implementer

- Restyle player-facing Spec 01 screens (home/lobby/banner/seat-picker) into
  the theme; leave host-facing markup functional-ugly (Spec 05's job).
- The projection is the security boundary — the UI renders what it gets and
  nothing else; if a screen "needs" data the projection lacks, that's a spec
  conversation, not a client-side computation.
- Keep components dumb; anything resembling game rules belongs in Spec 02.
- Deviations → `docs/specs/04-implementation-notes.md`.
