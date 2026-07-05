# Spec 08 — team lock-in voting, My Role button, Instructions: implementation notes

Built against baseline `300dc2d` ("Hotfix: share link never fails silently +
honest start-gate minimum"). `npm test` (engine 40/40, client 10/10, server
40/40); `npm run typecheck` clean; `npx playwright test --workers=1` 32/32,
two consecutive clean runs, zero flakes.

## D1 — engine

**Shared resolver, built first as required.** New `src/engine/consensus.ts`:
`resolveConsensus(votes, killers, mode, {lockedOnly})` returns
`{ready, converged, target}` — `ready` is the per-mode readiness gate (all
relevant killers have a qualifying vote; designated mode gates on only the
designated killer), `converged` is whether a target is actually agreed
(unanimous requires equal targets among the counted votes; majority/
designated always converge once ready), `target` is present iff converged.
A second export, `resolveLockedPlurality(votes, killers)`, is the force-
advance/timer fallback: plurality among LOCKED votes only, ties by seat,
ignoring the ruleset's consensus mode and its convergence outcome entirely
(this is what lets a host break a unanimous deadlock or resolve an
under-locked majority/designated group). All three former duplicate sites
route through these: `resolveMafiaTarget` (resolve-night.ts, now takes a
`forced` flag choosing which of the two functions to call),
`pendingNight`/new `mafiaReady` (machine.ts), and the `you.factionVotes`/
`consensusReached` block (project.ts).

**Natural-advance gate is `ready && (converged || killers.length === 0)`,
not `ready` alone.** Initially wired `mafiaReady` off `ready` only, which
broke the unanimous-disagreement pin: once all killers lock on DIFFERENT
targets, `ready` is true (everyone's locked) but nothing has converged —
the phase must stay open ("keep deciding"), not silently auto-advance with
no kill. Caught by a new test (`"lock-in: all-locked-disagree (unanimous)
stays open"`) before it could ship wrong.

**`MafiaVote` gained `locked: boolean`.** `submitAction`'s mafia branch
always writes `locked: false` on any (re)submission, including a changed
target on top of an existing lock — this is the pinned "changing target
clears an existing lock" behavior, achieved for free by rebuilding the vote
record from scratch on every submit rather than patching `targetId` in
place.

**New commands** `lockAction`/`unlockAction` (`src/engine/types.ts`), a new
`setMafiaLock` handler in `machine.ts`: phase-gated before role-gated (both
paths reject `not_lockable`, matching the spec's explicit "never silently
ignored" pin for a lock/unlock arriving after the night has resolved),
`no_pick_to_lock` when no target is set. New log events `actionLocked`/
`actionUnlocked` (`GameEvent` union in `shared/game-view.ts`) — required a
one-line fix to `src/client/screens/host/HostLog.tsx`'s `describe()` switch
(previously exhaustive over the old `GameEvent` union; TypeScript correctly
flagged the now-non-exhaustive switch once the two new variants were added,
surfacing as a build break, not a runtime bug).

**Projection**: `you.factionVotes` is BREAKING-reshaped per the spec —
`{voterId, targetId, locked}[]` covering every living non-absent killer
(undecided → `targetId: null`), never just those who've picked. Added
`you.lockedCount`. `you.consensusReached` redefined to
`resolveConsensus(...).converged` under `lockedOnly: true`. Host `acted`
(v2.7) amended for mafia: `vote.targetId !== null && vote.locked` (was
`!== null` alone) — non-mafia individual actors unchanged.

**Real bug found and fixed, not introduced by this spec but surfaced by its
new test coverage**: `you.factionVotes`'s gate was `role.nightAction
?.consensus === "mafia" && state.phase === "night"` with no `viewerPlayer
.alive` check — a dead ex-mafia's own re-projection still carries
`roleId: "mafia"`, so this leaked LIVE teammate tentative/locked picks for
the current unresolved night to a player who is now dead, violating Spec
02 v2.2's "dead god view stays resolved-only" pin (pre-dates Spec 08; the
old shape just never happened to have a test exercising a dead mafia's own
view mid-night). Fixed by adding `viewerPlayer.alive &&` to the gate.
Regression test: `"projection: factionVotes leak-free — ... no live
tentative picks leak to a dead ex-mafia's mid-night god view"`.

Engine suite: 40/40 (was 27). New tests: 12 dedicated Spec 08 tests (D1's
full acceptance list: tentative doesn't resolve, all-locked-agree resolves,
all-locked-disagree stays open, majority plurality-of-locked, force/timer
locked-only (both zero-locked and one-locked-one-tentative sub-cases),
markAbsent unblocks, unlock re-opens, changing target clears lock,
designated-mode gate irrelevance, protocol rejections, factionVotes shape/
lockedCount/consensusReached, factionVotes leak-free) plus the dead-god-view
leak fix above folded into that last one.

**UPDATED (not just added), per the spec's explicit authorization**, the
five existing engine tests that submitted-without-locking and expected a
kill on force/timer or natural advance:
- `"night kill, angel protection, detective result, and dawn reveal
  resolve through NAR"` (~line 47 pre-change) — added a `lockAction` for
  the sole mafia before the night naturally resolves.
- `"mafia consensus modes and absent denominator use uniform plurality
  fallback"` (~line 136) — split the first sub-case into two (force with
  nothing locked → no kill; force with the sole vote locked → lands), and
  added `lockAction` calls to the absent-denominator/majority/designated
  sub-cases so they exercise natural (non-forced) resolution correctly.
- `"unanimous consensus timeout resolves as plurality among submitted
  mafia votes"` (~line 161) → renamed to "... among LOCKED mafia votes",
  all three votes now lock (proving the unanimous-disagreement "stays
  open" pin) before force-advancing; added a companion test for the
  unlocked-tentative case (force yields zero kill, the behavior that
  actually changed from the old rule).
- `"forceAdvance mid-night applies the same defaults, including mafia
  plurality-of-submitted"` (~line 276) → renamed "...-of-LOCKED", the
  lands-case now locks first; added a companion unlocked-submitted case
  showing the new zero-kill outcome.
- `"fixture Godfather fools detective, Jester wins, and Escort mutual-
  roleblock cancels blocks"` (~line 204) — the Escort sub-case's sole
  mafia now locks before force-advancing.

Also updated the v2.7 `acted` test (mafia case): submitting alone now
asserts `acted === false` (tentative = pending); only after `lockAction`
does it flip to `true`.

## D2 — protocol/DO

`src/shared/protocol.ts`: `LockActionMessage`/`UnlockActionMessage` added
to `ClientMessage`. No new `ErrorCode` — `no_pick_to_lock`/`not_lockable`
are `rejection` codes (bare strings on `RejectionMessage`), same channel
every other in-game command rejection uses; consistent with `not_a_player`/
`no_game` etc. already being un-typed rejection strings.

`src/server/game-room.ts`: two new `case` branches in the command switch,
same one-liner shape as `retract_vote`'s (`handleGameCommand`, host has no
`playerId` so gets `not_a_player`).

`src/client/store/gameStore.ts`: `lockAction()`/`unlockAction()` intent
helpers (send-only, no client logic) + two rejection-copy entries.

Server suite: 40/40 (was 35). New `describe("Spec 08:
lock_action/unlock_action")` block, 5 tests: lock/unlock round-trip
(projected `locked` flips both directions over the wire); night resolves
only after all killers lock (tentative submissions alone never end it);
authority (non-killer → `not_lockable`; host socket, which has no
`playerId` at all → `not_a_player`, proving no crash); `no_pick_to_lock`;
lock/unlock arriving after the night has already resolved → `not_lockable`,
never silently ignored (both directions).

**UPDATED (not just added)**, per the spec's authorization, the 4 existing
pool-workers tests whose scripted single-mafia night relied on
submit-without-lock naturally resolving: the full scripted game (both
night 1 and night 2), the mid-night-eviction-survives test, the
player-triggered-alarm-arming test, and the join-order-never-reorders test
— each gained a `lock_action` send (and matching `drainSnapshots`) for the
sole mafia right before the night's other actors' actions complete it.

## D3 — team-voting UI

`src/client/screens/game/NightActionDrawer.tsx`'s `MafiaNightPanel`
rewritten: a new `TeammatePicks` sub-component renders every entry in
`you.factionVotes` as `name → target-or-"deciding…"`, with a locked ✓ /
"(tentative)" marker and "You" for the viewer's own row (server-order
list, not sorted by anything client-side); a `Lock in`/`Unlock` toggle
button (`disabled` until `you.pendingAction` has a target — this DISABLED
state is server-round-trip-driven, not local click-optimism, which is the
exact race D1's implementation-notes-adjacent E2E work below had to
account for); a status line covering all three pinned states ("N of M
locked · waiting…", "Consensus reached.", and "Everyone's locked in, but
you don't agree — keep deciding." for the unanimous-disagreement case).
`you.mafiaRoster` panel unchanged, still rendered below.

Playwright: `test/e2e/lockin-role-instructions.spec.ts`, two dedicated
lock-in scenarios — two real mafia browser contexts see each other's live
tentative picks update (including a mismatched-then-matched-but-still-
tentative dance that must never resolve), lock only resolves the night
once both are locked AND agreed, and a full unlock-before-second-lock →
still-open → re-lock → resolves round trip.

**Real race found via this new coverage, not an app bug**: the
`lock-in-button`'s `disabled` state depends on the SERVER's confirmation of
`you.pendingAction` (a WebSocket round trip), not the immediate client-side
selection highlight. Clicking the lock button back-to-back with the target
submission (with no wait) intermittently fired the lock request before the
target had actually landed server-side, silently no-op'ing (Playwright's
auto-wait does wait for "enabled", but the button could still be
momentarily disabled at click-time on a loaded dev server). Fixed
test-side only (not app code — the disabled gating is correct and
intentional; it's what stops a player from locking with no pick): every
E2E lock click across `game.spec.ts`, `game-components.spec.ts`,
`host-console.spec.ts`, and the new lock-in spec now explicitly
`await expect(lockButton).toBeEnabled()` before clicking. `game.spec.ts`
also gained a small `submitAndLockMafiaTarget` helper for the common
single-mafia case.

## D4 — My Role button + Instructions

`src/client/components/MyRoleButton.tsx` (new): a persistent fixed
bottom-left button (🎭 "My Role", ≥44px), mounted unconditionally in
`GameScreen.tsx` alongside the existing `RoleReveal`/`HoldToPeek` — present
in every in-game phase (night/dawn/day/voting/dusk/ended) including for
dead viewers and the ended/`GameEnd` screen, since `GameScreen.tsx` renders
it before branching on phase. Opens a Radix Dialog reusing a newly exported
`RoleCard` (lifted out of `RoleReveal.tsx`, given two new optional props —
`mafiaRoster`/`playerNames` — so the "My Role" dialog can show the mafia
roster/minion info the spec pins, which the original `RoleReveal`/
`HoldToPeek` call sites never needed and still don't use). Stays open until
dismissed (tap-out or a Close button); nothing role-identifying exists in
the DOM until tapped.

`src/client/components/HelpButton.tsx` (new): thin "?" icon wrapper owning
its own open/close state, dropped into `Lobby.tsx`, `HostLobby.tsx`,
`GameScreen.tsx` (fixed bottom-right, in-game), and `HostGame.tsx`'s header
— lobby AND in-game per the spec.

`src/client/components/Instructions.tsx` (new): static modal, no server
involvement. Content sourced from `src/client/lib/roleCopy.ts`, EXTENDED
(not replaced) with a new optional `instructionsBlurb` field per role and
an exported `HOUSE_ROLE_IDS` ordering constant — no second `roleInfo.ts`,
per the spec's explicit instruction. Sections: objective, day/night loop,
tie/vote rules, mafia lock-in explainer, and all six house roles.

Playwright (`lockin-role-instructions.spec.ts`): My Role button reachable
across night/dawn/day, works for a dead viewer showing their real role
(the underlying game happens to end at the transition into dawn for this
seed's parity math — see below — the button still needs to and does work
regardless), privacy assertion (button opens/closes with no permanent role
text left VISIBLE afterward — see the `innerText()` note below); Instructions
modal opens from both the lobby and in-game headers and closes cleanly
without disrupting an in-progress night action.

**Privacy assertion note — structural, matching the spec's own exemption
language, not a naive `innerHTML` grep.** `HoldToPeek`'s content (Spec 04)
is always present in the DOM, CSS-hidden (`display:none`) until pressed —
this is the pre-existing, spec-exempt pattern ("mount-then-dismiss" via
visibility, not unmount). A raw `#root.innerHTML()` `.not.toContain(...)`
check false-positives on this every time, since `innerHTML` includes
hidden markup. Used `#root.innerText()` instead (Playwright/browser
semantics: `innerText` only returns rendered/visible text, honoring
`display:none`), which correctly ignores HoldToPeek's hidden content while
still failing on a genuine always-visible role badge, matching the spec's
own "the 5s auto-reveal Dialog and the tap-opened My-Role card both
mount-then-dismiss and are exempt... a permanently-mounted role badge would
fail" language.

**5-player/2-mafia parity note (test-authoring constraint, not an app
issue)**: seed 42's house-rules game has exactly 2 mafia among 5 players —
any single night kill immediately reaches mafia parity (2 mafia vs 2
remaining town), so win evaluation fires at the moment of the night→dawn
transition itself and the game jumps straight from `"night"` to `"ended"`;
a real intermediate `"dawn"` phase is never independently observable for an
instant-win kill (confirmed by reading `machine.ts`'s `advancePhase`/
`withWin`: the win check runs against the already-dawn-transitioned state
and overwrites `phase` to `"ended"` before that intermediate state is ever
returned to a caller). The "dead player My Role button" test accounts for
this by waiting for `"ended"` rather than `"dawn"` — the assertion under
test (a dead viewer's button still works) doesn't depend on which of the
two terminal-ish states the game lands in.

## Verification

```
npm run typecheck          # tsc --build --force, all project references — clean
npm test                   # engine 40/40, client 10/10, server 40/40
npx playwright test --workers=1   # 32/32, two consecutive clean runs, zero flakes
```

Static acceptance checks (all pass):
```
grep -rn "cloudflare\|Date.now\|new Date(\|Math.random" src/engine   # no hits
jq -r '.dependencies|keys[]' package.json | sort   # unchanged, exact 7-package budget
grep -rn "innerHTML\|dangerouslySetInnerHTML" src/client   # no hits
find src/client -iname "roleInfo*"   # no hits — extended roleCopy.ts instead
```

`git diff --stat` confirms the touched-file set matches the deliverable
boundaries above; new files: `src/engine/consensus.ts`,
`src/client/components/{MyRoleButton,HelpButton,Instructions}.tsx`,
`test/e2e/lockin-role-instructions.spec.ts`.

No new dependencies. No commits made (orchestrator-owned).

STATUS: complete, suites green.
