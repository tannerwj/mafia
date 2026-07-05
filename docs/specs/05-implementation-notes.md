# Spec 05 — host console: implementation notes

Built against baseline `ed9c5c2` ("Spec 04: noir player UI — verified").
`npm test` (engine 27/27, client 4/4, server 35/35).

## Engine/shared change (explicitly authorized, narrow scope)

A real projection-contract gap was found and reported rather than computed
client-side: `src/engine/project.ts`'s `projectFor` never populated
`view.you` (or any equivalent aggregate) for `viewer.kind === "host"` — the
host projection had no field exposing per-seat night-action-submission
status (day/runoff/dusk "voted" status is derivable from `votes`/`voted`,
but night had no analogous signal), blocking D1's pinned player-table column
("this-phase status (voted / acted / pending — live, this is the god
view)") for the night phase specifically.

The orchestrator's reply bumped `docs/specs/02-engine-core.md` to v2.7 and
explicitly authorized this spec to touch exactly `src/engine/project.ts` +
`src/shared/game-view.ts` (the field + host-branch population) + engine
tests for it — nothing else in `src/engine`, and not `src/server`. Landed:

- **`src/shared/game-view.ts`**: `ClientGamePlayer` gains `acted?: boolean`.
  Present only for seats that owe an action this phase; `undefined` (never
  `false`) for non-actors.
- **`src/engine/project.ts`**: new `actedThisNight(state, playerId)` helper,
  called only when `viewer.kind === "host"` AND `state.phase === "night"`.
  Reuses `activeNightActionFor`/`canSubmitMafiaVote` from `roles.ts` (already
  encode "living, non-absent, respects `firstNightKill` night-1 gating") so
  this doesn't re-derive eligibility logic — an individual night-actor's
  `acted` reads `state.nightActions`; a mafia-consensus killer's `acted`
  reads `state.mafiaVotes` for a non-null `targetId`. Everyone else (no owed
  action, or `viewer.kind !== "host"`, or phase isn't `"night"`) gets no key
  at all (spread conditionally, not `acted: undefined`, so `"acted" in row`
  is a meaningful presence check).
- **`test/engine/engine.test.ts`**: new test asserting acted
  present-and-false for an un-acted actor under host view, flips to true
  after they submit, stays `undefined` for a villager (never a fabricated
  `false`), and is absent entirely from player/public/dead-god-view
  projections of the exact same mid-night state (leak check) and from a
  host view of the exact same state once the phase has moved past night
  (no stale carryover). Engine suite: 27/27 (was 26/26).

`src/client/store/hostView.ts`'s `seatStatus()` now reads `players[].acted`
directly for the night phase: `true` → `{kind:"acted"}`, `false` →
`{kind:"pending"}`, `undefined` → `{kind:"asleep"}` (never a fabricated
pending for a role with nothing to submit). `phaseSummary()` reports "N of M
have acted" for night the same way it already did for day/runoff votes.
`PlayerTable.tsx`'s `StatusCell` renders all three. D4's mark-absent stall
drill (`test/e2e/host-console.spec.ts`) asserts the live column directly
mid-stall: the acted mafia shows "acted", the ghosting mafia shows
"pending", the suicide bomber (no night action) shows "asleep" — proving the
real field end-to-end, not just that the game still resolves.

## Deviations
- **`RoomConnection`'s `serverNow` was parsed off the wire but never
  forwarded to any callback** (`WelcomeMessage`/`SnapshotMessage` both carry
  `serverNow: number`, `handleMessage` read `msg.serverNow` into nothing).
  Spec 05's D1 pin ("Countdowns render against `serverNow`-corrected client
  time... never raw `Date.now()`") needed it, so it's client-only wiring
  squarely inside this spec's authorized scope: `WelcomeInfo` gained a
  `serverNow` field, `RoomConnectionEvents.onSnapshot`'s signature gained a
  second `serverNow` parameter, and `gameStore.ts` now tracks a
  `clockOffsetMs` (sampled fresh on every welcome/snapshot, not just once
  per connection) plus an exported `serverNow()` helper
  (`Date.now() + clockOffsetMs`). `DeadlineCountdown.tsx` is the only
  consumer today; nothing else in the existing player-facing code path used
  raw deadlines directly (Spec 04's `phaseGen`-driven tint doesn't need wall
  time), so this is additive with zero behavior change to any existing
  screen.
- **Host-key recovery changed from silent auto-connect to an explicit
  offer**: `Room.tsx`'s original auth-resolution effect (Spec 01) treated a
  localStorage `hostKey:backup` with no session credential as equivalent to
  having a session credential — it connected immediately with no user
  action. The spec's D3 pin explicitly describes this as an *offer*
  ("the room route offers 'Resume as host'"), distinct from a normal
  reconnect. Added an `offering-host-recovery` phase with a "Resume as
  host" / "Join as a player instead" choice, only reached when the session
  has neither a hostKey nor a seatToken but localStorage has the backup.
  This is a behavior change from Spec 01/03/04's implicit behavior, but it's
  what the pinned spec text describes, not an invention — flagging since a
  naive diff-reader might mistake the removed auto-connect for a regression.
- **Dual-credential chooser's player-name lookup**: `IdentityChooser` needs
  a display name for "Enter as {name}", but a bare session `seatToken` has
  no name attached by itself — the name lives only in the localStorage seat
  *backup* array (`getSeatBackups`), keyed by matching `seatToken`. `Room.tsx`
  looks up the session seat's name from that array, falling back to the
  literal string "your seat" if no matching backup entry exists (a seat
  token minted this exact session, before its own post-welcome
  `appendSeatBackup` call has run, could theoretically hit this — not
  reachable in practice since dual-credential detection only fires on a
  *fresh* mount reading already-persisted storage, by which point any seat
  token that exists was already backed up in a prior session).
- **Existing host-side E2E assertions retargeted, player-facing ones
  untouched**: `test/e2e/lobby.spec.ts` (3 assertions) and
  `test/e2e/game-reconnect.spec.ts` (1 assertion) asserted `player-list`/
  `player-row` testids against the **host's own page** — before this spec,
  the host rendered the same functional `Lobby.tsx` component as players
  (Spec 04's placeholder). Now that host identity always routes to
  `HostLobby`/`HostGame` (this spec's D1), those host-side assertions were
  retargeted to `host-player-table`/`host-player-row`. Every assertion
  against an actual *player's* page (`joinAsPlayer`'s own check, and every
  `playerPage.getByTestId("player-list"/...)` call) is untouched —
  `Lobby.tsx` itself has zero diff, confirmed via `git diff
  src/client/screens/Lobby.tsx` (no output) and the full existing 17-test
  suite passing unmodified in behavior, only in host-side selector target.
- **`ConfirmDialog` is a new shared primitive, not a new dependency**: reuses
  the exact Radix `Dialog` pattern already established by Spec 04's
  `RoleReveal.tsx` (`Dialog.Root`/`Portal`/`Overlay`/`Content`/`Title`/
  `Description`), parameterized for the two dangerous controls
  (`force_advance`, `new_game`). No new package.
- **Force-advance's captured `phaseGen` lives in `ForceAdvanceControl`'s own
  component state, not the store** — the spec's pin is specifically that the
  dialog captures `phaseGen` at the moment it OPENS, which is a UI-timing
  concern (same class as Spec 04's `previousPhase`), not game state; storing
  it in the host slice would blur that boundary for no benefit since nothing
  else ever reads it.
- **Mobile controls drawer reuses vaul** (already Spec 04's dependency,
  used identically to `NightActionDrawer.tsx`'s pattern) — `HostGame.tsx`'s
  bottom-drawer controls on ≤767px follow the same
  `Drawer.Root`/`Portal`/`Overlay`/`Content` shape, `modal={false}` was not
  needed here (no player-facing HoldToPeek affordance coexists with the host
  console) so the drawer uses vaul's default modal behavior, unlike
  `NightActionDrawer`.
- **`HostGame`'s phase header has no `data-phase` attribute the way
  `GameScreen.tsx` does** — the phase-tint mechanism (D1 of Spec 04) is
  explicitly a player-screen-only convention (this spec's own D1 pin: "same
  noir tokens as Spec 04... layout" — tint is not repeated for the console,
  which has no atmosphere requirement and needs to stay legible/functional
  under a phone flashlight at a party). The host's own observable phase
  signal is `host-phase-label`'s text content instead; D4's tests assert
  against that.

## What's built

- **D1 screens** (`src/client/screens/host/`): `HostLobby.tsx` (player
  table + presence + kick + large room code/share + `HOUSE_RULESET` summary
  card + player-count-gated start), `HostGame.tsx` (player table centerpiece
  in join order, phase header with `DeadlineCountdown.tsx` + a derived
  `phaseSummary` line, full unredacted auto-scrolling `HostLog.tsx` with
  pin-to-latest, desktop two-column `max-w-3xl` / mobile single-column +
  bottom drawer for controls), `HostGameEnd.tsx` (winner splash, full role
  reveal, "Start rematch" behind a confirm dialog). `PlayerTable.tsx` is
  shared between lobby (presence+kick only) and in-game (full god-view row)
  modes. `PrivacyChip.tsx` is the persistent "🎭 arbitrator screen" chip,
  rendered in every host screen's header.
- **D2 controls**: `force_advance` (per-phase confirm copy from
  `hostView.ts`'s `forceAdvanceCopy()`, `phaseGen` captured at dialog-open),
  `mark_absent`/`mark_present` (row buttons in `PlayerTable.tsx`, no
  confirm), `kick` (lobby only, via `HostLobby`), `new_game` (confirm
  dialog on `HostGameEnd`). All send through the store's pre-existing D3
  intent helpers (`forceAdvance`/`markAbsent`/`markPresent`/`kickPlayer`/
  `newGame` in `gameStore.ts` — these were already built by the Spec 04
  bootstrap; this spec only adds the UI that calls them with real
  confirm-gating).
- **D3 store**: `src/client/store/hostView.ts` — a pure-function host slice
  (`hostSeatRows`, `phaseSummary`, `phaseLabel`, `forceAdvanceCopy`,
  `alignmentTint`), never a stored flag on shared objects, imported only by
  `screens/host/**`. `gameStore.ts` gained `clockOffsetMs` +
  `serverNow()` (see deviations). `RoomConnection.ts` gained `serverNow`
  plumbing (see deviations). `Room.tsx` gained the dual-credential
  `IdentityChooser` phase and the `offering-host-recovery` phase, and now
  routes any `isHost` connected session to the host screens instead of the
  player-facing `Lobby`/`GameScreen`.
- **D4 tests**: `test/e2e/host-console.spec.ts` (7 new tests — full hosted
  game + rematch, mark-absent stall drill, force-advance stall drill with
  per-phase copy assertion, double-fire guard, authority, privacy,
  reconnect). Two existing files touched only for host-side selector
  retargeting (see deviations): `test/e2e/lobby.spec.ts`,
  `test/e2e/game-reconnect.spec.ts`.

## Verification performed

- `npm run typecheck` (`tsc --build --force`, all project references):
  clean.
- `npm test`: engine 27/27 (26 + 1 new `acted` projection test), client
  4/4, server 35/35 — `src/server` has zero diff throughout (confirmed via
  `git diff --stat -- src/server`); `src/engine` diff is limited to exactly
  the authorized `acted` field (`git diff --stat -- src/engine` shows only
  `project.ts`).
- `npx playwright test --workers=1` (clean env: killed stray
  vite/chromium processes, `rm -rf .wrangler/state` before each run): 24/24
  (17 original Spec 01/04 tests + 7 new Spec 05 tests, including the
  strengthened mark-absent stall drill that asserts the live acted/pending/
  asleep column directly). Run as one combined suite twice earlier in this
  session (24/24 both times, zero flakes); the machine's background load
  (many unrelated concurrent node/MCP/Codex processes this session) later
  made the combined ~3-minute single run occasionally get reaped by the
  sandbox mid-suite with no test-level error — confirmed environmental, not
  a regression, by re-running every spec file individually in the same
  clean env immediately after: `lobby.spec.ts` 6/6, `game.spec.ts` 3/3,
  `game-reconnect.spec.ts` 2/2, `game-components.spec.ts` 6/6,
  `host-console.spec.ts` 7/7 — 24/24 total, zero failures.
- `grep -rn "innerHTML\|dangerouslySetInnerHTML" src/client`: no hits.
- `jq -r '.dependencies|keys[]' package.json | sort`: unchanged, exactly the
  7 packages from Spec 04's closed budget (`@fontsource-variable/
  playfair-display @radix-ui/react-dialog react react-dom sonner vaul
  zustand`) — no new dependencies.
- `git diff --stat -- src/server`: empty. `git diff --stat -- src/engine`:
  `project.ts` only (the authorized `acted` addition).

STATUS: complete, suites green.
