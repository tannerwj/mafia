# Spec 04 — Player UI (noir): implementation notes

Built against baseline `cb8afac` ("Spec 03: DO ⇄ engine integration —
verified"). No network access in this environment — the five new
dependencies are added to `package.json` but not installed; every source
file is written against each package's real current API (verified via
Context7/training knowledge, then cross-checked by shimming matching `.d.ts`
stubs into a scratch `node_modules` and running `tsc --build --force`
clean across all 4 project references — the shims were deleted afterward,
they are not part of this deliverable). `npm test` (engine 24/24, server
35/35) still green throughout; untouched by this spec.

## Deviations

- **Hidden-mode voting has no per-viewer "your own vote" field in the
  projection either** (`ClientGameView` only carries the full `votes` array
  in realtime/god view, or a bare `voted: PlayerId[]` tally-count array in
  hidden mode — no field says what *I* voted for). The spec still pins "the
  UI always shows your current vote and lets you change it" unconditionally
  (not gated on voting-visibility mode), and that pin is achievable without
  violating the projection boundary: the voter trivially already knows their
  own choice because they're the one who clicked it. `DayVoting.tsx` tracks
  the just-cast target in local component state (`localVote`), corrected by
  the server's own `votes` array the instant one is present (realtime/god),
  and reset whenever `${phase}:${day}` changes (a new voting round). This is
  presentation state, the same class as the spec's own `previousPhase` — not
  derived game logic, since it never infers anything about *other* players.
  **Residual gap, documented rather than silently shipped**: on a genuine
  page reload/reconnect mid-vote in hidden mode (component remounts, losing
  `localVote`), the projection gives no way to restore "what did I vote for"
  — the highlight will show nothing until the voter re-clicks (harmless:
  `cast_vote` is idempotent and changeable, so re-clicking their own name
  simply re-confirms it), but strictly speaking the highlight is briefly
  wrong on that one reload path. A future projection revision adding e.g.
  `you.myVote?: VoteTarget` would close this cleanly; flagging rather than
  fixing further client-side, since deriving it would mean caching votes
  outside the `RoomConnection`-hydrated store, which D3 pins against.
- **Minion does not see the mafia roster, contrary to the spec's D2 prose
  ("minion sees mafia list") and design.md's "Minions are shown who the
  Mafia are".** Verified directly against `src/engine/project.ts`: a living
  non-mafia viewer's `you.*` object has no field carrying other players'
  roleId (the only such fields are `factionVotes`/`consensusReached`, gated
  on `role.nightAction?.consensus === "mafia"` — minion's `HOUSE_ROLE_DEFS`
  entry has no `nightAction` at all), and `players[].roleId` is only
  populated via `revealForPublic` (death-gated) or full god view (host/dead/
  ended). Inventing a mafia-roster field client-side would violate the
  pinned rule "the projection is the security boundary — the UI renders
  what it gets and nothing else." Minion renders the same idle "the town
  sleeps" state as villager/suicide_bomber
  (`src/client/screens/game/NightActionDrawer.tsx`). This is a projection
  contract gap, not a client bug — flagging for a future spec revision to
  add e.g. `you.mafiaRoster?: PlayerId[]` gated on `knowledgeAtStart ===
  "mafia"`.
- **No host-facing "Start game" / "New game" trigger existed anywhere in the
  Spec 01 client, and D4 requires driving full games through "host
  (functional Spec 01 screens) + 4 player contexts."** Host console UI is
  explicitly Spec 05's job, but Spec 05 hasn't shipped, so there was no way
  to reach a running game at all without adding *something*. Added the
  minimum functional trigger to `Lobby.tsx`'s host-only branch: a plain
  unstyled `data-testid="start-game"` button that always sends
  `HOUSE_RULESET` (a client-local literal mirroring `src/engine/ruleset.ts`'s
  `HOUSE_RULES` shape — not an import from `src/engine`, this spec stays
  client-only) plus an optional seed read from a `sessionStorage` test hook
  (`src/client/lib/houseRuleset.ts`'s `testSeedOverride()` — inert in
  production regardless of what's in storage, since the server only honors
  `start_game.seed` when its own `ALLOW_TEST_SEED` env is set, per Spec
  03). Same reasoning for a `data-testid="new-game"` button on `GameEnd`.
  Both are deliberately functional-ugly (`border-stone-400`/`bg-stone-800`,
  not noir tokens) — restyling the host console is explicitly out of scope
  here and is Spec 05's job; this is the smallest possible addition to make
  D4's own required tests reachable at all.
- **5-player games under `HOUSE_RULES`'s auto mafia formula always yield
  exactly 2 mafia, never 1** (`autoMafiaCount(5, "sqrt") = round(sqrt(5)) =
  2`; `HOUSE_RULES.roles` is `{mafia:"auto", villager:"auto", detective:1,
  angel:1, suicide_bomber:1, minion:0}`, and for 5 players the auto
  villager count is `max(0, 5 - 2 - 1 - 1 - 1) = 0`). The spec's D4 script
  text reads naturally as a single mafia ("mafia converge on a kill" reads
  equally well for 2), but a solo-mafia 5-player game is not reachable
  through the ruleset the client actually sends (there is no client UI to
  send a different one — that's Spec 06's ruleset editor). All three
  Playwright scenarios in `test/e2e/game.spec.ts` were redesigned around 2
  mafia + 0 villagers, with exact seed→role mappings verified directly
  against `startGame(players, HOUSE_RULES, seed, 0)` before being pinned
  (see the comment block above each `test.describe`). Scenario A now runs
  two full night/day cycles (eliminating one mafia via a runoff, then the
  second via a clean vote) rather than ending after the first runoff,
  because parity math (`mafiaTeam >= everyoneElse`) does not resolve the
  game after only one of two mafia is eliminated.
- **`cn()` has no `clsx`/`tailwind-merge`.** Neither is in the closed
  dependency budget. Implemented as a minimal `filter(Boolean).join(" ")` in
  `src/client/lib/cn.ts` — every class list in this codebase is hand-written
  and non-conflicting (no dynamically-generated Tailwind utility pairs that
  would need `tailwind-merge`'s conflict resolution), so the bare join
  covers every call site actually used.
- **shadcn `Button` is hand-written, not CLI-generated.** No network/CLI
  access to run `npx shadcn@latest add button`. `src/client/components/ui/
  button.tsx` follows the standard shadcn Button source shape (a
  `buttonVariants`-style class map + `React.forwardRef` wrapping a native
  `<button>`) by hand, adapted to the noir tokens (`blood`/`brass`/`ink`/
  `smoke`/`bone` instead of shadcn's default palette) and to this repo's
  `cn()`. No `class-variance-authority` dependency (also not in budget) —
  variants are a plain `Record<Variant, string>` lookup instead of `cva()`.
  Every size keeps a >=44px tap target per D2's pin, including `sm`.
- **Radix `Dialog.Title`/`Dialog.Description` and vaul `Drawer.Title`/
  `Drawer.Description` are present but visually hidden via a hand-rolled
  `.sr-only` CSS class**, not `@radix-ui/react-visually-hidden` (a separate
  package, not in the closed dependency budget — vaul's own docs use it,
  but nothing requires it; a standard clip-rect sr-only pattern achieves
  the identical effect and is one CSS rule, already added to `index.css`
  alongside the HoldToPeek `.no-callout` utility).
- **Playfair Display is imported as `@import
  "@fontsource-variable/playfair-display";`** (bare package import, no
  subpath) inside `index.css`, immediately after `@import "tailwindcss";`.
  Verified this resolves to the package's `exports["."]` → `./index.css`
  (weight axis 400-900, normal style) and registers the family name
  `"Playfair Display Variable"` exactly, which is what `--font-display` in
  the `@theme` block references. The package also ships `wght-italic.css`
  (unused — this app never sets italic). **Actual bundled woff2 size is not
  yet measured** — this environment has no network access to install the
  package and run `vite build`; the orchestrator should record the real
  transferred size (likely a handful of woff2 subset files, since Fontsource
  splits by unicode-range) in a follow-up note once verified post-install.
- **`RoomConnection` gained an `onRejection` event** (previously only
  `onStatusChange`/`onWelcome`/`onSnapshot`/`onKicked`/`onError`/
  `onBadCredential`) and a `case "rejection"` branch in `handleMessage` —
  Spec 03 added the `RejectionMessage` wire type and DO-side send calls, but
  Spec 01's original `RoomConnection.ts` predates that and never routed it
  to a callback (it silently fell through the `switch`, matching no case,
  which is harmless but meant rejections had no client-side surface at
  all). D3 requires surfacing `rejection{code}` as a toast — this is the
  minimal wiring needed, additive only, no existing behavior changed.
- **The zustand store's `connect()` takes an optional third `hooks`
  parameter** (`RoomLifecycleHooks`: `onWelcome`/`onKicked`/
  `onBadCredential`/`onError`) instead of Room.tsx constructing its own
  second `RoomConnection`. The store owns hydration (`room`/`connection`/
  `previousPhase` — the D3-pinned single source of truth); Room.tsx's own
  auth-resolution phase machine (picking-seat/kicked/bad-credential/
  connected — Spec 01 lifecycle logic, not game state) still needs to react
  to `welcome`/`kicked`/`badCredential`/`error` for its own local state
  (seat/hostKey persistence, navigation). Threading these as an optional
  parameter keeps exactly one `RoomConnection` instance per room, which a
  naive "Room.tsx makes its own connection too" approach would have
  violated.
- **`test/e2e/game.spec.ts` re-derives seed→role mappings directly against
  `startGame(players, HOUSE_RULES, seed, 0)`** rather than reusing
  `test/server/game-room.test.ts`'s seed 19 (that test's `FIVE_PLAYER_
  HOUSE_RULES` uses *fixed* role counts — `{mafia:1, villager:2,
  detective:1, angel:1, suicide_bomber:0}` — which the client-facing
  `HOUSE_RULESET` does not send; the client always sends `HOUSE_RULES`'s
  real auto-formula shape, which yields a different role distribution
  entirely for the same seed). Seeds used: 42 (scenario A), 1 (scenario B),
  59 (scenario C) — each verified with a throwaway `test/engine/
  __seed_probe*.test.ts` script (run and deleted, not shipped) before being
  hardcoded into assertions, per the task brief's instruction not to guess.

## What's built

- **D1 theme**: `src/client/index.css` — `@theme` tokens (ink/ink-2/ink-3/
  blood/brass/bone/smoke), `--font-display` (Playfair Display Variable) /
  `--font-sans` (system stack), dark-always (`color-scheme: dark`, no light
  mode anywhere), `.phase-tint`/`data-tint` mechanism (300ms fade,
  interruptible — the latest snapshot always wins immediately, no queueing),
  `.safe-top`/`.safe-bottom`/`.safe-x` (env() safe-area-inset utilities,
  Tailwind v4 has no built-in equivalent), `.no-callout` (HoldToPeek's
  iOS-callout defeat), `.sr-only`. `index.html` gained `viewport-fit=cover`
  and a `theme-color` meta tag.
- **D2 screens**: `src/client/screens/Home.tsx`, `Lobby.tsx`,
  `SeatPicker.tsx`, `ConnectionBanner.tsx` restyled in place (testids
  preserved); `src/client/components/HoldToPeek.tsx` (pointer events +
  capture, `touch-action:none`, real `<button>`, Enter/Space gives a 3s
  `aria-live`-announced timed reveal); `src/client/components/RoleReveal.tsx`
  (Radix Dialog, 5s auto-dismiss, then HoldToPeek); `src/client/screens/
  game/NightActionDrawer.tsx` (vaul bottom sheet; mafia/detective/angel
  panels + idle state for villager/minion/suicide_bomber);
  `src/client/screens/game/Interstitial.tsx` (dawn/dusk, log-event display
  formatting only); `src/client/screens/game/DayVoting.tsx` (grid +
  `no_murder` "Spare the town" card, change-vote, hidden/realtime tally,
  runoff-only-candidates); `src/client/screens/game/DeadGodView.tsx`;
  `src/client/screens/game/GameEnd.tsx`; `src/client/screens/game/
  GameScreen.tsx` (phase router + phase-tint wrapper, mounted by `Room.tsx`
  once `state.game !== null`).
- **D3 store + wiring**: `src/client/store/gameStore.ts` (zustand;
  `connection`/`room`/`isHost`/`playerId`/`previousPhase`/`lastError`/`conn`
  fields; intent helpers `submitAction`/`castVote`/`retractVote`/
  `markAbsent`/`markPresent`/`forceAdvance`/`kickPlayer`/`startGame`/
  `newGame`; `rejection{code}` → `sonner` `toast()` with a human-copy
  lookup table, unknown codes fall back to the raw code rather than being
  swallowed). `src/client/App.tsx` mounts a single `<Toaster>`.
  `src/client/net/RoomConnection.ts` gained `onRejection` (see deviations).
- **D4 tests**: `test/e2e/game.spec.ts` (3 full seeded scenarios + DOM-level
  privacy assertions), `test/e2e/game-reconnect.spec.ts` (mid-night
  socket-drop + restore with pending-action state verified restored;
  two-pages-one-context regression inside a running game),
  `test/e2e/game-components.spec.ts` (HoldToPeek pointer + keyboard paths,
  vote-change re-render, hidden-mode tally). `test/e2e/lobby.spec.ts` was
  not modified — its selectors/testids are untouched by the restyle.

## Verification performed in this environment (no network)

- `npx tsc --build --force` across all 4 project references: **clean**,
  confirmed twice — once showing only the expected missing-module errors
  for the 5 new packages (and their cascade into `noImplicitAny` on
  downstream inference), and once with hand-written `.d.ts` stubs shimmed
  into a scratch `node_modules` matching each package's real exported shape
  (verified via Context7/training knowledge) to prove the application code
  itself is correct independent of the install step. Shims were deleted
  before finishing; they are not part of this deliverable and must not be
  mistaken for real packages by anyone inspecting `node_modules`.
- `npm test` (engine 24/24, server 35/35): green, unaffected (this spec
  never touches `src/engine` or `src/server`).
- `grep -r "innerHTML\|dangerouslySetInnerHTML" src/client`: no hits.
- `grep -r "fonts.googleapis\|fonts.gstatic\|cdn\." src/ index.html`: no
  hits.
- `jq -r '.dependencies|keys[]' package.json | sort` equals exactly
  `@fontsource-variable/playfair-display @radix-ui/react-dialog react
  react-dom sonner vaul zustand` — matches the spec's mechanical check.
- Playwright suites (`game.spec.ts`, `game-reconnect.spec.ts`,
  `game-components.spec.ts`) were written and typecheck clean but **could
  not be executed** — they require the real packages' runtime code (not
  just type declarations) to build and serve via `vite dev`, which needs
  `npm install`. Same for a DevTools mobile-viewport screenshot pass (the
  spec's "Live" acceptance criterion) and the `test/e2e/lobby.spec.ts`
  regression check.

Side note for the orchestrator: `package-lock.json` shows the 5 new
dependencies' metadata already resolved (added by some background process
in this environment during this session — not an action taken deliberately
here; `node_modules` itself was never populated with the real packages, only
temporary hand-written `.d.ts` shims that were deleted before finishing).
`npm install` should reconcile this normally regardless.

STATUS: ready-for-install

## Fix round 1 (post-install, real packages verified in node_modules)

- **Task 1 (role-reveal Dialog stuck open) — no code change needed.**
  Investigated `RoleReveal.tsx`'s dismiss-timer effect in detail: it keys
  off `roleId`, arms a fresh 5s `setTimeout` on every effect invocation
  (cleaned up by the same invocation), and only flips `open` to `true` via
  a ref-guard that fires once per distinct `roleId` value — this is correct
  as written. Ran `npx playwright test` from a clean install four times
  total across this session (twice before touching any code, twice after);
  all runs were 15-17/17 green with zero flakes on this test. The reported
  stuck-dialog failure did not reproduce and was very likely a stale
  snapshot from before dependencies were fully reconciled in
  `node_modules` — not a live bug.
- **`src/shared/game-view.ts`**: added `you.mafiaRoster?: PlayerId[]` and
  `you.currentVote?: VoteTarget` per Spec 02 v2.6.
- **`src/engine/project.ts`**: `mafiaRoster` is built from role identity
  (`nightAction?.consensus === "mafia"`), not `mafiaKillers()` — the latter
  zeroes out on `firstNightKill:false` night 1 and excludes absent/dead
  players, which is correct for kill-eligibility but wrong for a static
  "who is on my team" knowledge grant. Present for living minion AND mafia
  viewers (partner knowledge, self excluded), key entirely absent for
  everyone else including dead/god view (a living-viewer-only grant, not a
  god-view field). `currentVote` reads the viewer's own entry out of
  `state.votes` for any living viewer, independent of
  `ruleset.votingVisibility` — absent (not `undefined`-valued, no key) when
  they haven't voted.
- **`test/engine/engine.test.ts`**: two new tests — `mafiaRoster` presence/
  absence across minion/mafia/villager/dead-god-view, and `currentVote`
  round-tripping through cast/change/retract under both `hidden` and
  `realtime` votingVisibility. Engine suite: 26/26 (was 24/24).
  `test/server/game-room.test.ts`'s privacy sweep (`describe("projection
  privacy sweep")`) needed no change — it only inspects `frame.game.players`
  (other players' `roleId`/`alignment`), never keys on the viewer's own
  `you` object, so the new fields don't intersect its assertions.
- **`src/client/screens/game/NightActionDrawer.tsx`**: minion (no
  `nightAction`, so no drawer to open) now renders a `MinionNightPanel`
  (`data-testid="minion-idle"`) showing `you.mafiaRoster` via a new shared
  `MafiaRoster` display component, instead of falling into the generic
  `IdleTownSleeps` state it shared with villager/suicide_bomber before this
  field existed. Mafia's own night panel also renders the same roster
  (`data-testid="mafia-roster"`) below the consensus block.
- **`src/client/screens/game/DayVoting.tsx`**: (a) removed the `localVote`
  component-state mirror and its `roundKeyRef` reset effect entirely —
  `myVote` now reads `you.currentVote` directly, closing the exact
  reload-mid-vote gap flagged in the original deviations section above,
  since the store's hydrated snapshot is now the only source of truth for
  this value, same as everything else the component reads. (b) added the
  same `mafiaRoster` panel above the vote grid for day-phase minion/mafia
  viewers.
- **`src/client/lib/houseRuleset.ts` / `src/client/screens/Room.tsx`**:
  added `testRolesOverride()`, a test-only sessionStorage hook
  (`mafia:testRoles`, JSON-encoded role-count patch) exactly mirroring
  `testSeedOverride()`'s existing gating and inertness — required because
  `HOUSE_RULESET.roles.minion` is hardcoded to `0` (no host ruleset-editor
  UI exists yet; that's Spec 06), so a minion is otherwise unreachable
  through the real client flow at all. Server-side `validateRuleset`
  re-validates whatever ruleset arrives regardless; this is a wire-payload
  override, not new game logic, and ships the same way `testSeedOverride`
  already did.
- **`test/e2e/game-components.spec.ts`**: two new tests. (1)
  `you.mafiaRoster` — seed 1 with role override
  `{mafia:1, villager:1, minion:1, suicide_bomber:0}` (detective/angel:1
  kept from the house-rules base, sums to 5) yields Alice:minion,
  Bob:detective, Carol:villager, Dave:mafia, Erin:angel (verified against
  `startGame` with this exact roles object via a throwaway seed-probe test,
  run and deleted, not shipped — same method the original implementer used
  for `game.spec.ts`'s seeds). Asserts Alice's minion night+day views
  render Dave's name via `mafia-roster`, and Carol's villager night+day
  views never render the `mafia-roster` testid or Dave's name anywhere in
  the DOM. (2) `you.currentVote` — casts a vote, hard-reloads the page
  (full remount, not just a re-render), and asserts the vote highlight is
  restored from the freshly-hydrated snapshot with no re-click needed.

Final verification (this session, real installed packages): `npm run
typecheck` clean; `npm test` — engine 26/26, server 35/35; `npx playwright
test` — 17/17, run twice consecutively with zero flakes. Dependency
manifest unchanged (`jq -r '.dependencies|keys[]' package.json | sort`
still exactly matches the closed budget); `grep -r "fonts.googleapis\|
fonts.gstatic\|cdn\.\|innerHTML\|dangerouslySetInnerHTML" src/ index.html`
still no hits.

STATUS: fix-round-1 complete, suites green

## Fix round 2 (visual gate findings)

- **BUG (opacity) — `src/client/screens/game/GameScreen.tsx` /
  `src/client/index.css`**: the visible "screens sit at ~40-90% opacity"
  symptom was real, root-caused via `requestAnimationFrame`-sampled opacity
  traces (script written/discarded, not shipped) against a live `npm run
  dev` instance: `usePhaseTint`'s fade is actually TWO sequential CSS
  transitions — fade-out while `data-tint="fading"`, then fade-in once the
  attribute swaps to the resolved tint bucket (removing `"fading"` is
  itself an attribute change that retriggers the same `transition:
  opacity` rule). Both legs were set to the full 300ms each, so the true
  settle time for any phase transition was ~600ms, not the spec's pinned
  "300ms fade through black" — screens were correctly mid-transition when
  screenshotted (the tour script's `phase()` helper has zero settle
  buffer), just for twice as long as intended, which is what made it look
  "stuck" in static captures. Fix: halved both `FADE_MS` (150) and the CSS
  `transition` durations (150ms) so the full out+in cycle lands at ~300ms
  (verified via the same rAF-sampling method: opacity reaches 1 at
  ~302ms post-trigger, down from ~604-620ms). Also hardened
  `usePhaseTint` to key off `phaseGen` (the engine's own monotonic
  per-transition counter) instead of the raw `phase` string with a
  `fading` boolean set via an un-guarded `setTimeout` callback — the old
  version had a narrower theoretical race where a stale timer from an
  interrupted transition could clear a newer one's fade state; the
  `phaseGen`-keyed version's timeout callback only clears the fade if
  `current === phaseGen`, so an old timer can never clobber a fresher one.
  This second issue never reproduced in isolation across ~10 stress runs,
  but is strictly more correct and was effectively free alongside the
  main fix.
- **BUG (mafia consensus denominator) — confirmed and fixed** in
  `src/client/screens/game/NightActionDrawer.tsx`'s `MafiaNightPanel`:
  `you.factionVotes` (`state.mafiaVotes` filtered to killers) only
  contains entries for partners who have ALREADY submitted a vote —
  it starts as `[]` and grows, so `factionVotes.length` undercounts the
  denominator ("0 of 0 partners" before anyone votes, instead of "0 of
  N"). Fixed by computing the denominator from `you.mafiaRoster` (Spec 02
  v2.6, this session's round 1 addition) instead: total living killers =
  `mafiaRoster.length + 1` (partners + self), which is always correct
  regardless of how many have voted yet.
- **POLISH ("Back" bar) — confirmed as a real bug, not polish** in
  `src/client/screens/ConnectionBanner.tsx`: the brass "Back" flash
  treated `status === "connecting"` the same as `status === "reconnecting"`
  when deciding `wasDown`, so the very FIRST connection on every fresh
  page load (join, reload, new tab) also passes through "connecting" en
  route to "open" and was flashing the 2s brass "Back" banner — not just
  genuine drop-then-recover events. With 5-6 browser contexts navigating
  throughout the tour script, at least one was almost always mid-flash at
  any given screenshot, which is why it appeared on every screen. Fixed by
  only arming `wasDown` on `"reconnecting"`. `test/e2e/lobby.spec.ts`'s
  socket-drop reconnect test (line ~168) still passes unmodified — a real
  drop after being connected goes through `"reconnecting"`, never
  `"connecting"`, so its assertion path is untouched.
- **POLISH (duplicate death line) — confirmed and fixed** in
  `src/client/screens/game/DeadGodView.tsx`'s `ResolvedHistory`: a day-vote
  elimination always logs both `playerDied{cause:"vote"}` AND
  `voteResolved{eliminatedId}` (`src/engine/machine.ts`'s `killByVote`
  pushes both for the same event, by design — `voteResolved` also carries
  `reason` for the no-elimination cases, which is legitimate and out of
  this spec's authorized `src/engine` scope to change). Fixed purely in
  the UI: only render the `voteResolved` line when `eliminatedId` is
  `null` (tie/no_murder/peace outcomes, which have no matching
  `playerDied`) — a set `eliminatedId` is always already covered by the
  `playerDied` line rendered above it, so rendering both was reporting
  the same death twice.
- **VERIFY (detective results not visible on day screen) — confirmed
  absent, now wired**: `src/client/screens/game/DayVoting.tsx` never
  rendered `you.investigationResults` at all — the detective's findings
  were only ever shown inside the night drawer (`NightActionDrawer.tsx`'s
  `InvestigationHistory`), so once day arrived a detective had no way to
  see their own history for the rest of the game. Added the same
  `data-testid="investigation-history"` panel to `DayVoting.tsx`, above
  the mafia-roster panel, gated on `you.investigationResults` being
  non-empty.

All five items were reproduced against a live `npm run dev` instance
before fixing (via the orchestrator's `ui-tour-04.mjs` plus one-off
diagnostic scripts written in `/tmp`, run, and discarded — none shipped)
and re-verified visually afterward by re-running `ui-tour-04.mjs` and
inspecting the regenerated `ui04-*.png` screenshots: full-brightness day/
dead-god-view/game-end screens, correct "0 of 2 partners" denominator, no
brass "Back" bar on any screen, single death line, and detective findings
visible on the day screen.

Final gate re-run (fresh, no stale dev server — killed leftover process
on :5173 before and after): `npm run typecheck` clean; `npm test` —
engine 26/26, server 35/35; `npx playwright test` — 17/17, run twice
consecutively with zero flakes.

STATUS: fix-round-2 complete, suites green

## Fix round 3 (E2E timeout headroom — partial, one test still flaky)

- Raised `waitForPhase` defaults and every explicit override from 10s to
  25s, and the `role-reveal-dialog`-detached waits from 7s to 15s, across
  `test/e2e/game.spec.ts`, `test/e2e/game-reconnect.spec.ts`, and
  `test/e2e/game-components.spec.ts`. No app code touched; no assertion
  values loosened.
- **Real bug found and fixed in `test/e2e/game-reconnect.spec.ts`
  (test-file only, not app code)**: the socket-drop test's
  `__openSockets` wrapper closed EVERY open WebSocket on the page,
  including the dev server's own Vite HMR socket, in the same synchronous
  loop as the room socket. Reproduced directly (isolated repro scripts,
  written and discarded, not shipped): closing only the room socket fires
  its `close` event and shows the reconnect banner within 1s, every time;
  closing both together intermittently suppresses the room socket's
  `close` event entirely, sometimes for 70s+ with no other timeout able to
  compensate since the event never fires at all. Fixed by tagging each
  socket as room-vs-other at construction and only closing the room one.
  This measurably improved the drop-detection leg.
- Raised the two reconnect-scenario assertion timeouts substantially
  (banner-appears: 15s to 50s; banner-clears-after-recovery: 30s to
  150s) and the test's own `testInfo.setTimeout` from Playwright's 30s
  default to 240s, after finding Playwright's per-test timeout was
  capping the test before either assertion's own timeout could matter.
  Added `test.describe.configure({ retries: 2 })` scoped to this file
  only (not the shared `playwright.config.ts`, which already carries the
  team lead's own `workers: 2` pin).
- **Not fully resolved.** Even after the socket-close fix and all timeout
  increases above, `test/e2e/game-reconnect.spec.ts`'s "kill network
  mid-night" test still fails intermittently — traced directly via
  Playwright's own trace network log: after `setOffline(false)`, the
  client's WebSocket sometimes cycles through several full connect
  (succeeds, HTTP 101) -> stays alive ~29.5s -> drops -> reconnect loops
  before ever settling, and in the worst observed run it never settled
  within a 150s assertion window (302 consecutive "still visible" polls).
  This 29.5s per-cycle pattern doesn't match any of `RoomConnection`'s own
  constants (heartbeat 25s, liveness 40s, backoff cap 15s) and looks
  consistent with the documented "real workerd alarms on one shared dev
  server" flake class (CLAUDE.md process-rules note, 2026-07-04) rather
  than a client-side logic bug — but this is inference from trace timing,
  not a confirmed root cause, and I could not converge it with
  timeout/retry adjustments alone within this fix-round's scope (test
  changes only, no app code). All 16 other Playwright tests, including
  `lobby.spec.ts`'s equivalent (simpler, lobby-only, no game running)
  socket-drop test, pass reliably (confirmed clean across every run this
  session) — the flake is specific to this one mid-game scenario.

Verification this round: `npm run typecheck` clean throughout; `npm test`
unaffected (engine/server untouched); `npx playwright test --grep-invert
"kill network"` — 16/16 green, repeatedly; the "kill network" test itself
measured at roughly 50-90% pass rate across ~15+ isolated runs this
session (improved from its pre-fix baseline, not yet fully stable).

STATUS: fix-round-3 partial — 16/17 solid, one test (game-reconnect.spec.ts
"kill network mid-night...") still intermittently flaky after real fixes;
flagging for the orchestrator rather than claiming false stability.

## Fix round 3 continued — precise root cause found (still not a
## test-timeout-fixable issue)

Re-tested solo (team lead confirmed and stopped concurrent suite runs, per
their round-3 follow-up). Extracted and read the Playwright trace's own
network HAR directly for a failing run: after `setOffline(false)`, the
client's room WebSocket goes through repeated cycles of: connect succeeds
(HTTP 101) -> stays alive for almost exactly ~29.5-29.9s each time -> drops
-> immediately reconnects -> repeat. Observed 5 consecutive such cycles in
one run (~155s of pure cycling) before the assertion timeout gave up.

Root cause, found by grep: `src/server/game-room.ts`'s `AUTH_REAP_MS =
30_000` — the server marks every newly-accepted WebSocket as
"pendingAuth" and force-closes it with `CLOSE_AUTH_TIMEOUT` (4002) if
`hello` hasn't completed within 30s. `RoomConnection.ts` treats
`CLOSE_AUTH_TIMEOUT` as retryable (correct in general) and loops back into
`scheduleReconnect()`. The ~29.5s cycle length matches `AUTH_REAP_MS`
almost exactly, meaning: the socket opens successfully, but its `hello`
message is never completing auth server-side, so every single reconnect
attempt gets reaped at the 30s mark and the client retries into the exact
same failure — an infinite loop, not "slow," so no timeout size fixes it.

Working theory (not proven further — would require app-code changes to
verify, which round-3's scope forbids): `context.setOffline(true)` /
`setOffline(false)` toggling via CDP may leave the socket's `send()` call
queued-but-undelivered for the immediate post-open `hello` message
specifically in this test's exact sequence (offline set, socket
force-closed, later un-set) — the TCP/WS handshake completing (101) does
not guarantee CDP's network-condition emulation has fully settled for
outbound application data at that same instant. This is consistent with
`lobby.spec.ts`'s equivalent test never failing: it never starts a game,
so there's less concurrent socket/timer activity for a send-timing race to
land badly in.

This is now root-caused as an infinite retry loop, not variance — no
`expect(...).timeout` value, however large, converges it once a run lands
in this cycle, since the client and server are both behaving "correctly"
per their own retry contracts, just never successfully completing one
handshake. Fixing this for real would need either app-code changes (e.g.
client-side: detect N consecutive `CLOSE_AUTH_TIMEOUT`s and do something
different; server-side: investigate why `hello` isn't landing) or a
different test-side trigger for the drop that doesn't interact with
`setOffline` this way — both out of this round's stated scope (timeouts
only, no app code, no assertion changes).

Reverted all temporary debug instrumentation from
`test/e2e/game-reconnect.spec.ts`; the file is left in the same
timeout-only-changed state as fix-round-3's first pass (waitForPhase
10s->25s, role-reveal-detach 7s->15s, room-socket-only close fix, banner
waits 50s/150s, test-level timeout 240s, retries:2 scoped to this file).

STATUS: fix-round-3 root-caused, not resolvable via timeout/retry alone —
escalating to orchestrator for a scope decision.

## Fix round 4 (app code authorized) — three real bugs, root-caused and fixed

The team lead's own discriminating probe (two raw WS clients, one idle one
pinging, both survived 100s) proved the server/workerd never kills healthy
steady-state sockets — narrowing this to client-side `RoomConnection.ts`.
Investigation found not one bug but three, stacked, each masking the next
until the previous was fixed:

1. **Missing socket-generation guard** (`src/client/net/RoomConnection.ts`).
   `forceRecycle()` replaces `this.ws` synchronously, but the discarded
   socket's own `.close()` call resolves asynchronously — its `open`/
   `message`/`close` listeners (closures over the OLD socket) could still
   fire after a newer socket had already taken over, unconditionally
   overwriting `this.ws`/`this.attempt`/`lastMessageAt` with stale data.
   Added a `generation` counter, bumped once per `connect()` call and
   captured per-listener; every listener now checks `gen ===
   this.generation` before touching shared state. Regression test:
   `test/client/RoomConnection.test.ts` (new `client` vitest project, see
   below) — proven sensitive by temporarily stripping the guard and
   confirming the test fails exactly as expected, then restoring it.

2. **The actual reconnect-cycling root cause: stale `join` auth replayed on
   every reconnect** (`src/client/store/gameStore.ts`). Found by reading a
   Playwright trace's raw WebSocket frame contents directly (not
   inference): a fresh-joined player's reconnect attempt sent
   `{"type":"hello","auth":{"kind":"join","name":"Erin"}}` — the ORIGINAL
   join credential — instead of the seat token the server granted in the
   first `welcome`. The server correctly rejects a second `join` once the
   game has started (`error: game_in_progress`), so the socket never
   authenticates, sits "pendingAuth" until the server's own `AUTH_REAP_MS`
   (30s) timeout kills it, and the client retries with the exact same
   stale `join` forever — the ~29.5s cycle from fix-round-3's trace
   analysis was this loop, not a server-side timer bug. `RoomConnection`
   already had a `setAuth()` method built for exactly this handoff but it
   was never called anywhere in the codebase. `Room.tsx`'s `onWelcome`
   persisted the new seat token to `sessionStorage` (correct, for a FUTURE
   page reload) but never updated the LIVE `RoomConnection` instance's
   in-memory `auth` field for a reconnect that happens without a reload.
   Fixed in `gameStore.ts`'s `connect()`: `onWelcome` now calls
   `conn.setAuth({kind: "seat", seatToken: info.seatToken})` whenever a
   seat token is present (harmless idempotent no-op on the `seat`-auth
   path, since it re-affirms the same token). Verified directly via trace:
   post-fix, the reconnect's `hello` correctly carries the seat token and
   `welcome` returns in ~2ms, with the connection then staying alive
   (144s+ observed) instead of cycling.

3. **The "Back" banner permanently stuck visible even after (2) fixed the
   network** (`src/client/screens/ConnectionBanner.tsx`). Render-level
   console tracing (added temporarily, removed before finishing) proved
   `RoomConnection`'s status genuinely reaches `"open"` within
   milliseconds of recovery — this was purely a UI-state bug. Root cause:
   the single `useEffect` that both (a) transitioned `wasDown` ->
   `showBack` on recovery and (b) reset `wasDown` to `false` in that same
   run had `wasDown` in its own dependency array — setting it to `false`
   immediately re-triggered the effect, and React's cleanup-before-next-run
   semantics tore down the freshly-armed 2-second `setTimeout` via
   `clearTimeout` before it ever fired, permanently stranding `showBack` at
   `true`. Fixed by splitting into two effects: one that only detects the
   down-then-open transition (sets `wasDown`/`everOpened`/`showBack`), and
   a second that owns the 2s timer, keyed only on `showBack` itself (which
   it doesn't also mutate mid-run) — so arming the timer and any future
   `wasDown` transition can no longer cancel each other out.

Also, one residual E2E-only flake (not an app bug) found and fixed purely
in the test file: `test/e2e/game-reconnect.spec.ts` was calling
`context.setOffline(true)` BEFORE force-closing the room socket — closing
a socket while already offline can leave its `close` event un-fired
for the full assertion timeout (the close handshake itself needs a live
transport to complete). Reordered to close first, then flip offline
(still fully simulates the drop, since offline blocks the SUBSEQUENT
reconnect attempt from succeeding). This took the drop-detection leg from
~50% first-attempt flake rate to 12/12 clean in isolated stress runs.

**New `client` vitest project** (`vitest.config.ts`, `tsconfig
.client-test.json`, `package.json`'s `test` script): unit-tests
`src/client/net/RoomConnection.ts`'s reconnect state machine with fake
timers and a hand-rolled `WebSocket`/`window`/`document`/`location` stub
surface — no `jsdom` (not in Spec 04's closed dependency budget; the
surface `RoomConnection` actually touches is small enough to stub by
hand). Two tests: (1) the exact generation-guard regression scenario
(proven to fail without the fix), (2) a sanity check that a genuine
current-socket drop still reconnects normally (proving the guard doesn't
over-suppress legitimate reconnects).

**Files touched**: `src/client/net/RoomConnection.ts` (generation guard),
`src/client/store/gameStore.ts` (setAuth on welcome),
`src/client/screens/ConnectionBanner.tsx` (split effects), `test/client/
RoomConnection.test.ts` (new), `tsconfig.client-test.json` (new),
`tsconfig.json` (new project reference), `vitest.config.ts` (new `client`
project), `package.json` (test script includes `client` project),
`test/e2e/game-reconnect.spec.ts` (close-before-offline reorder only —
timeouts/retries from fix-round-3 unchanged and no longer even needed at
their full size, but left as-is since they're harmless headroom, not
touched further this round to keep the diff minimal).

**Stability gate**: three consecutive solo `npx playwright test` runs,
17/17, zero retries, zero flakes, ~1.1 minutes each (previously the
reconnect test alone could take 2.5+ minutes and still fail). `npm run
typecheck` clean; `npm test` — engine 26/26, client 2/2 (new), server
35/35.

## Fix round 4, refined — client-side auth-response fail-fast hardening

The team lead's refined brief unified their stale-watchdog probe with my
`AUTH_REAP_MS` trace finding and asked for one more thing regardless of
root cause: don't let the client wait out the SERVER's 30s reap timer to
notice its own `hello` went unanswered. Added `AUTH_RESPONSE_TIMEOUT_MS`
(5s) to `src/client/net/RoomConnection.ts`: after sending `hello` on socket
open, arm a 5s timer; if neither `welcome` nor `error` clears it by then,
`forceRecycle()` immediately rather than waiting for the server's own
`CLOSE_AUTH_TIMEOUT` reap. Generation-guarded (the timer callback checks
`gen === this.generation` before acting, same pattern as every other
listener) and cleared on `welcome`, `error`, any `close`, and `close()`/
`forceRecycle()` themselves, so it can never double-fire or race a
legitimate late response. This is pure hardening on top of the already-
fixed root cause (the stale-`join`-auth bug in fix-round-4's item 2 above)
— with that fixed, `hello` now succeeds on the first attempt every time in
practice, so this timer is defense-in-depth against a future regression or
any residual rare frame-loss case, not something needed to pass the gate.

Verified the fix-not-the-comment: temporarily stripped the timer-arming
block, confirmed the new dedicated unit test fails exactly as expected
(2 sockets never materializes because nothing forces the recycle), then
restored it and confirmed green again.

Two new unit tests added to `test/client/RoomConnection.test.ts` (now 4
total): (1) a `hello` met with silence recycles at 5s, well before the
server's 30s or the client's own 40s liveness timeout would have caught
it; (2) an `error` response (e.g. `game_in_progress` for a stale `join`)
clears the auth-timeout timer instead of also firing a redundant recycle
on top of whatever the caller does with the error.

Final gate re-run after this addition: `npm run typecheck` clean; `npm
test` — engine 26/26, client 4/4, server 35/35; three consecutive solo
`npx playwright test` runs — 17/17 each, zero retries (one unrelated
one-off flake in `game.spec.ts` scenario C was observed between gate runs
during this round — a `dawn`→`day` phase-wait timeout with no reconnect/
offline logic involved at all, consistent with this project's documented
"workerd alarms under parallelism" flake class rather than a regression
from this change; it passed cleanly on immediate re-run and did not
recur across the three counted gate runs).

STATUS: fix-round-4 complete, 3x stable
