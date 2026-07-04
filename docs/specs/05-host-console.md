# Spec 05 — Host console

**v2 — 2026-07-04 · Status: approved for build**
*v2 folds in all findings from Codex adversarial review (2026-07-04): the
stall drill's engine semantics now exist (Spec 02 v2.3 — absent players
leave consensus denominators; uniform factional-kill resolution on every
advance path), force_advance carries `{gen}` (Spec 02/03 double-fire guard),
deadlineAt/absent/phaseGen added to projections, per-phase confirm copy,
dual-credential chooser, host-key recovery affordance, serverNow clock
offset. No findings overruled.*
Parent: PLAN.md §Host console. Depends on: Specs 01–04. Host-facing only.
The host is a pure arbitrator (decision 2026-07-04) — never a player.

## Goal

The arbitrator's cockpit: the host runs an entire game — start it, watch
every role and pending action live, unstick any phase, manage flaky humans —
from one screen (phone-capable, laptop-comfortable). Done looks like: the
Playwright suite runs a full game where the host resolves a stalled night
via mark-absent, breaks a deadlock via force-advance, and starts a rematch,
all through this UI; DevTools screenshots pass design review in both 390px
and 1024px widths.

## Non-goals

Ruleset *editing* (Spec 06 — v1 of this console starts games with
`HOUSE_RULES` verbatim). Player screens (Spec 04). Mid-game host migration
(the host key is transferable by hand — sharing the URL+key — but no UI for
it in v1).

## Pinned conventions

- **Data source**: exclusively `projectFor({kind:'host'})` via the composed
  snapshot (Spec 03) — live pending actions included. The console renders
  the host projection; it never receives player-projection data.
- **Layout**: same noir tokens as Spec 04 (D1 theme is shared). Mobile
  (≤430px): single column, controls in a bottom drawer. Desktop (≥768px):
  two columns — player table left, log + controls right. `max-w-3xl`.
- **The player table is the centerpiece** — one row per seat, join order
  (never reordered): name · role (serif, alignment-tinted: blood for
  mafia-team, bone for village, brass for neutral) · alive/dead ·
  connected/disconnected dot · absent badge · this-phase status (voted /
  acted / pending — live, this is the god view) · row actions
  (mark absent/present; kick in lobby only).
- **Phase header**: current phase + day, deadline countdown when a timer is
  set (server `deadlineAt` rendered client-side, drift-tolerant to ±2s),
  phase-appropriate summary line ("2 of 3 mafia have voted", "waiting on 4
  votes") derived from the host projection.
- **Dangerous controls confirm once**: `force_advance` and `new_game` use a
  confirm dialog stating consequences with **per-phase copy** (night: "N
  players have not acted; the mafia kill resolves by plurality of votes
  cast" — night force-advance does NOT mean the kill fizzles; day/runoff:
  "N players haven't voted — they will abstain"; dawn/dusk: "skip the
  reveal beat"). The dialog captures `phaseGen` when it OPENS and sends
  `force_advance {gen}` — if the phase moved meanwhile (other host tab,
  natural completion), the engine rejects `stale_advance` and the console
  toasts "already advanced". `mark_absent` does not confirm (reversible,
  urgent).
- **Rejections surface as toasts** (`rejection{code}` — e.g. force-advance
  raced a natural phase end: show "already advanced", never an error state).
- **Screen privacy warning**: the console shows every role — a persistent
  discreet "🎭 arbitrator screen — keep it private" chip in the header
  (players *will* glance at the host's phone at a party; make the host
  conscious of it).
- **Host reconnect** uses the same Spec 01 semantics (hostKey in storage,
  banner, resume); a second concurrent host connection is allowed (Spec 01
  multi-socket) — both render identically (double-fire is guarded by
  `{gen}`, above).
- **Dual credentials**: a browser may legitimately hold both a hostKey and
  a seatToken for one room (creator who also joined as a player from the
  same device — discouraged, but storage can't prevent it). Pinned: the
  room route shows an explicit identity chooser ("Enter as Host" / "Enter
  as {name}") whenever both exist — `hello` presents exactly the chosen
  credential; never auto-picked by storage-read order.
- **Host-key recovery**: if this browser's localStorage holds the room's
  hostKey backup but the session doesn't, the room route offers "Resume as
  host" (Spec 01 already keeps the backup — this is a client-side read, no
  protocol change). A dead host *phone* is recoverable from any browser the
  key was ever shown in/copied to; a permanently lost key on an untimed
  game still dead-ends at the 6h TTL — accepted (Spec 03's tradeoff),
  mitigated by the `validateRuleset` untimed warning.
- **Countdowns** render against `serverNow`-corrected client time
  (Spec 03 v2.2) — never raw `Date.now()`.

## Deliverables

**D1 — screens** (`src/client/screens/host/`): HostLobby (restyle Spec 01's
functional lobby: player list + presence, kick, share link + room code
large, start button with player-count gate and HOUSE_RULES summary card),
HostGame (player table, phase header, log — full unredacted log from host
projection, auto-scroll with pin-to-latest), HostGameEnd (result, full
reveal recap, "Start rematch" → `new_game`), all sharing the Spec 04
connection banner + store.

**D2 — controls wiring**: `start_game` (HOUSE_RULES verbatim; seed field
never sent by the console — it's test-only), `force_advance`,
`mark_absent`/`mark_present`, `kick` (lobby), `new_game`, with the
confirm-dialog policy above.

**D3 — store extension**: host slice on the Spec 04 zustand store (host
projection is a superset — the store must keep host-only data out of any
player-rendered path by construction: separate slice, not a flag on shared
objects).

**D4 — tests** (Playwright, extending the Spec 04 harness):
- Full hosted game: seed-fixed 5-player game driven end-to-end where the
  console is the only thing the "human" host touches.
- Stall drills (write these AFTER Spec 02 v2.3's absence pins are built —
  they assert that exact behavior): night stalls on a never-submitting
  mafia → host marks them absent → absent player leaves the consensus
  denominator → remaining mafia's converged pick resolves → game continues.
  Vote stalls → force-advance → per-phase confirm copy → dusk resolves.
  Double-fire: two host tabs, both dialogs open, both confirm → exactly one
  phase advances; second tab toasts "already advanced".
- Authority: player socket sending `force_advance` gets rejection (existing
  Spec 03 test) — console never renders another player's control surface.
- Privacy: host console DOM contains all roles (expected); simultaneously
  connected player context still never renders others' roles (regression).
- Reconnect: host tab killed mid-night → reopen → console restores with
  live pending state; players unaffected.
- Rematch: `new_game` from ended → all contexts land in lobby with seats
  intact.

## Acceptance criteria

CI: D4 green; typecheck; no new dependencies
(`jq` gate from Spec 04 unchanged).
Live (orchestrator): host a real multi-tab game start-to-finish touching
only the console for arbitration; screenshots at 390px and 1024px; verify
the host chip, countdown drift, and confirm dialogs read well.

## Notes for implementer

- Reuse Spec 04 components (Button, Dialog, drawer, toasts, banner) — this
  spec should add screens, not primitives.
- The host projection already contains everything; if a control needs data
  it lacks, that's a spec conversation (same rule as Spec 04).
- Deviations → `docs/specs/05-implementation-notes.md`.
