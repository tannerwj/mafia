# Spec 15 review findings — AI narrator ("The Storyteller")

Reviewer: adversarial pass, 2026-07-06. Target: `docs/specs/15-ai-narrator.md`
v1 DRAFT. Method: every claimed data element checked against the actual
projection/protocol/server code (file:line cited), not against the spec's own
description of itself.

---

## 1. KILLER — no `env.AI` binding exists anywhere in the deployed config

The spec's entire "Technical" section assumes `env.AI` is available today
("Cloudflare Workers AI via the `env.AI` binding (wrangler.jsonc `ai`
binding)"). It is not:

- `/Users/tjohnson/repos/mafia/wrangler.jsonc` declares exactly one binding
  block, `durable_objects` (lines 8–13). No `"ai": {...}` key exists.
- `worker-configuration.d.ts:12988` shows the generated `Env` interface is
  currently empty (`interface Env {}` merged with `__BaseEnv_Env` — no `AI`
  member). The `Ai` class the spec is presumably relying on
  (`worker-configuration.d.ts:10188`) is a generic runtime type, not proof a
  binding is wired to this Worker.
- `vitest.workers.config.ts` builds its Miniflare instance from
  `wrangler.jsonc` directly ("reuses the same wrangler config as dev/deploy")
  — so pool-workers tests get whatever bindings wrangler.jsonc declares,
  which today is zero AI bindings. The spec's claim "pool-workers supports
  binding stubs" is true in the abstract (Miniflare does support AI binding
  mocking) but is not wired into *this* repo's test config, and the spec
  doesn't list "add `ai` binding to wrangler.jsonc" as a deliverable at all —
  it's silently assumed to already exist.

This isn't a nitpick: it means D2/D3 cannot start until config-hygiene work
(adding the binding, regenerating `worker-configuration.d.ts` via
`wrangler types`) happens, and CLAUDE.md's role table puts wrangler.toml/
config tweaks in the *orchestrator's* lane, not the implementer's — the spec
needs to say so explicitly or the implementer will either silently add it
(scope creep on a "never edit config" boundary) or get blocked.

**Fix:** add an explicit deliverable: "orchestrator adds `ai` binding to
wrangler.jsonc + regenerates types before build starts," and gate D2 on it.

---

## 2. KILLER — the sunrise/sunset "Spin the tale" button is incoherent with deferred resolution

The spec (Product shape) says the "Spin the tale" button appears "on the
narrator board during sunrise/sunset holds," and the Leak contract's
Public-intersection rule claims `buildStoryFacts` can include "deaths since
last scene... the public morning-report beats... day-vote outcome."

But per `src/engine/machine.ts:334-344` and the Spec-12 design
(`docs/specs/12-narrator-board-scene-status.md:97-101`), sunrise/sunset are
**deferred-resolution holding states — the night/day is genuinely
UNRESOLVED while in them.** `resolveNight`/`resolveVote` have not run.
Concretely, during `sunrise`:

- `state.deaths` does not yet contain tonight's kill (added only inside
  `resolveNight`, called from `revealScene` at `machine.ts:369-372`).
- `state.players[].alive` is still pre-death.
- No `playerDied`/`attackAttempted` events exist in `state.log` yet for this
  beat — they're pushed during `resolveNight`.

So the "morning report beats" and "deaths since last scene" the spec wants to
feed into a sunrise-time generation **do not exist yet** — there is nothing
for `buildStoryFacts` to read for that beat. Two incoherent readings follow:

(a) If "Spin the tale" at sunrise is meant to generate the reveal narration
(the dramatic "who died" scene) — it CANNOT, because the facts aren't
resolved. The host would have to tap Reveal first, and the AI-scene option
should be offered at the resulting `dawn` phase (morning-report beat, which
the spec already separately lists) — sunrise is not a distinct beat with its
own facts, it's a strict subset/precursor of dawn with less information.

(b) If "Spin the tale" at sunrise is meant to be pure atmosphere ("the
narrator sets a scene while the town sleeps, before anyone knows the
outcome") — that's a legitimate, leak-safe beat, but then the spec's Public-
intersection rule is wrong to list "deaths since last scene" and "morning-
report beats" as available at that beat; it needs a SEPARATE, smaller facts
contract for sunrise/sunset (day/phase/roster/bible only — no deaths, no
attack-failed, no vote outcome), because at sunset the day vote is *also*
unresolved (`state.votes` still holds pending ballots per
`machine.ts:353-357`, not yet tallied via `resolveVote`).

The spec conflates two different beats (pre-reveal atmosphere vs.
post-reveal report) under one "sunrise/sunset hold" bullet and one shared
facts contract. As written, an implementer would wire `buildStoryFacts` to
read `state.deaths`/`state.log` for a "beat: sunrise" call and get either
stale data from the *previous* cycle (leaking nothing new, but silently
wrong — the scene would describe last night's death, not tonight's) or,
worse, someone "fixes" this by calling `resolveNight` early to get fresh
facts for the prompt — which is exactly the leak Spec 12 v2 was rewritten to
prevent (resolving early "so nothing can leak" is Spec 12's entire thesis;
Spec 15 must not re-introduce a code path that resolves state early just to
feed a prompt).

**Fix:** split the beat set explicitly:
- `beat: "sunrise-hold"` / `"sunset-hold"` — facts = settings + bible + day/
  phase/roster only, generated from the STILL-unresolved state, no deaths/
  votes/attack-failed. Available the moment sunrise/sunset is entered.
- `beat: "morning-report"` / `"post-vote"` — facts = deaths/attack-failed/
  vote-outcome, generated only from `dawn`/`dusk` state (post-reveal),
  matching what `Interstitial.tsx` already renders to players. If
  `scenePhases` is off, this is the only path; if on, it's the beat AFTER
  the host taps Reveal.
Pin exactly which phases legally accept `generate_story` per beat, and
require `buildStoryFacts` to reject/error if called with a beat whose
required facts aren't yet resolved in `state` (a structural guard, not just
prose).

---

## 3. MAJOR — "public intersection" is not a well-defined function of a single viewer today; the code has no "all-living-players" projection to derive from

The Leak contract says `buildStoryFacts` must be "derived from/validated
against" `projectFor`, and that it may include only what's "present in EVERY
living player's projection." But `projectFor(state, viewer)` is a
**per-viewer** function — there is no existing call that computes "the
intersection across all living players" as a single artifact. Concretely:

- `god` is true for `viewer.kind === "host"` OR a **dead** player OR
  `state.phase === "ended"` (`project.ts:104`). Dead players get the full god
  view (`docs/PLAN.md:29`, "Dead players get god view"). So "every living
  player's projection" is actually a narrower set than "every player's
  projection" — a dead spectator sees roles/night detail a living player
  never will. If an implementer computes the intersection by literally
  intersecting `projectFor` outputs across `state.players` (a natural,
  obvious implementation given the spec's wording), they will accidentally
  include dead players in the sample and get a false "this field is public"
  result the moment revealOnDeath is `"none"` and a dead player's own
  resolved-death entry differs from a living player's view of the same
  death. The spec must pin the exact viewer set: "every currently-ALIVE,
  non-absent player, `viewer = {kind:'player', id}`" — not `state.players`,
  not anyone with `god === true`.
- `votingVisibility` gates `view.votes` identically for every living player
  (`project.ts:141` — the condition doesn't vary per player), so that part
  of the intersection claim is actually sound (it's a room-wide flag, not a
  per-player leak surface) — but the spec should say "intersection reduces
  to a single ruleset-gated computation" rather than imply an actual per-
  player set-intersection is computed, because that's misleading about what
  "derived from/validated against projectFor" should mean in code. The
  cleanest correct design: `buildStoryFacts` does NOT call `projectFor` at
  all (there's no live socket/viewer to project for at facts-build time) —
  it reads `state` directly through the SAME gating helpers `projectFor`
  uses (`revealForPublic`, the `votingVisibility` check, `graveyard()`), so
  it can't diverge from the visibility policy. The spec's "validated
  against" language is vague enough that an implementer could build a
  parallel reimplementation (the anti-pattern the spec explicitly says to
  avoid in the same sentence) rather than sharing the actual helper
  functions. Name the specific functions to reuse: `revealForPublic`,
  `graveyard`, `rolesRemaining` are already exported... actually check: are
  they exported?

Checked: `revealForPublic` (project.ts:6), `hiddenVotingFilter` (14),
`resolvedLog` (27), `actedThisNight` (48), `rolesRemaining` (75), `graveyard`
(87) are all **module-private** (no `export`) in `project.ts` — only
`projectFor` and `narratorBoardHistory` are exported. So today there is
**no reusable exported helper** `buildStoryFacts` could call to get "deaths
with revealOnDeath applied" or "role counts" without either (a) exporting
`graveyard`/`rolesRemaining`/`revealForPublic` from `project.ts` — a real,
scoped code change to the sole-visibility-authority module the spec should
call out as a prerequisite — or (b) calling `projectFor(state, {kind:
"public"})`. Note `Viewer` already has a `"public"` kind
(`game-view.ts:46`) that **no code path uses today** (grep confirms
`projectFor` is only ever called with `{kind:"host"}` or
`{kind:"player",id}` from `game-room.ts:966-971`). `projectFor` under
`{kind: "public"}` would compute `viewerPlayer` as `undefined` (fine) and
`god` as `false` unless `state.phase === "ended"` — this actually looks like
it produces exactly the right document (graveyard, rolesRemaining, votes
per-ruleset, log filtered) with zero new code, IF `state.phase !== "ended"`
is handled (a completed game is a different beat — epilogue — and `god`
being forced `true` at `"ended"` is correct there, not a leak, since winners
are meant to be public).

**Fix:** pin `buildStoryFacts` to call `projectFor(state, {kind:
"public"})` (the existing, unused, exactly-fit-for-purpose viewer kind) as
its ONLY read of engine state, rather than "derived from/validated against"
language that leaves room for a parallel reimplementation. Add a note this
is the first real caller of `Viewer.kind === "public"` and it should get its
own dedicated tests in `project.test.ts` (today there may be zero coverage
of that branch — confirm before build).

---

## 4. MAJOR — no field exists today for "day-vote outcome incl. who was voted out"; log event names don't match spec's plain-English claim, and threshold/no-majority framing needs pinning

The spec says facts may include "day-vote outcome incl. who was voted out and
public tallies only if `votingVisibility` makes them public." The actual
source is `voteResolved` (`types.ts:41`: `{ eliminatedId: PlayerId | null;
day: number; reason: string }`), visible to non-host viewers via
`resolvedLog` (it's not filtered by `hiddenVotingFilter`, which only strips
`voteCast`/`voteRetracted`/`voteLocked`/`voteUnlocked` — `project.ts:19-24`).
So `voteResolved` (name/eliminated-or-null/reason) IS in every living
player's log unconditionally — good, that part is real and does NOT
actually depend on `votingVisibility` the way the spec implies. The spec's
phrasing ("day-vote outcome... only if votingVisibility makes them public")
incorrectly gates the *outcome* on `votingVisibility`; in the real code only
the **tallies** (`view.votes`, gated at `project.ts:141`) are
visibility-gated — the elimination result itself is always public (also
rendered unconditionally by `Interstitial.tsx:62-67`). Minor as stated, but
an implementer following the spec literally would write a
`votingVisibility`-gated guard around the elimination-name fact that
shouldn't be there, either hiding a fact that's actually always public (a
worse story, not a leak) or worse, inverting the check and gating the wrong
thing. Pin the exact fields: `voteResolved.eliminatedId`/`.reason` — always
available; `view.votes` tallies — gated by `votingVisibility` per
`project.ts:141`.

---

## 5. MAJOR — host-scoped delivery has no existing mechanism; `ClientRoomState` is not per-viewer at the room-scope layer today, and the spec's "rides the host's snapshot" claim needs a concrete field, not a wave

Today the ONLY per-viewer differentiation in the entire outbound wire format
happens inside `ClientGameView` (via `projectFor`, called per-socket in
`buildStateFor`, `game-room.ts:964-972`). The outer `ClientRoomState` shape
(`roomCode`, `players`, `hostConnected`, `pendingRuleset`) is
**viewer-independent** — every connected socket gets an identical
`ClientRoomState` except for the nested `game: ClientGameView | null` and
the top-level `WelcomeMessage.you`. There is no existing "host-only room
field."

The spec says: "storyState summary (settings + kept-scene count) rides the
host's snapshot for UI state" and separately "Host-scoped server → client:
`story_draft`... `story_error`..." implying two different delivery
mechanisms — one-off messages (`story_draft`) sent only to host sockets
(that pattern doesn't exist yet either — check: `game-room.ts` never sends a
`ServerMessage` to a subset of sockets keyed by role, aside from
`touchAndBroadcast` which sends a *personalized* snapshot to literally every
socket, and the one-off `welcome`/`kicked`/`error`/`rejection` sends which
are always to the single socket that triggered them, never "all host
sockets"). There can be MULTIPLE host sockets connected simultaneously
(nothing in `game-room.ts` limits host connections to one; `hostConnected`
is a boolean OR over `socketsFor(..., a.kind === "host")`, `game-room.ts:951`
— note it doesn't even distinguish COUNT, just presence). If two devices are
both logged in as host (plausible — a co-host phone, or an accidental double
tab), does `story_draft` go to both? The spec doesn't say, and the existing
code has no "broadcast to all host sockets" helper — `handleKick` and
`handleLeave` show the *pattern* (`socketsFor` + iterate + send) but nobody
has done it for a message type that must reach every host device while
NEVER reaching a player device. This is a real, non-trivial new server
capability, not a detail — call it out as an explicit protocol/DO
deliverable ("new `broadcastToHost()` helper, used by story_draft/
story_error, must be independently leak-tested: assert zero player socket
ever receives a `story_*` message even when host and player share... " —
actually they can't share a socket, but the point stands: needs its own
test, not implied by "same delivery discipline as god-view state," because
god-view state is delivered via the EXISTING per-socket-projection
mechanism, not a new targeted-broadcast mechanism.

Second half: adding `storyState summary` to `ClientRoomState` (viewer-
independent today, per above) would broadcast it to EVERY socket including
players, unless the spec pins it as a NEW field on the *host's own*
`ClientRoomState`, which requires `ClientRoomState` to stop being
viewer-independent — a bigger protocol change than the spec's one-line
mention suggests. **This needs to be either (a) folded into
`WelcomeMessage.you`/a host-only sibling type instead of `ClientRoomState`,
or (b) `ClientRoomState` gets a `storyStateSummary?: StoryStateSummary`
field that `buildStateFor` only populates when `viewer.kind === "host"`**
(structurally fine — `ClientGameView` already does per-viewer field
presence — but pin it explicitly as a `ClientRoomState` change, since that
type today has zero viewer-dependent fields and CLAUDE.md requires protocol
changes to go "only via a spec" — this spec needs to actually show the new
field, not gesture at "rides the snapshot").

---

## 6. MAJOR — `requestId` semantics on `generate_story`/`story_draft` are unspecified; race with Re-spin/Keep

The spec's protocol section lists `generate_story { beat, respin? }` (no
`requestId` on the client→server message) but `story_draft { beat, text,
requestId }` on the way back — so the server must mint the `requestId`, but
nothing says how the client correlates it to the tap that triggered it, or
what happens on double-tap ("Spin the tale" then immediately "Re-spin"
before the first draft returns). Concrete race: host taps generate for
`beat: dawn-day3`, AI call is in flight (up to 15s per spec), host taps
Re-spin again before the first resolves. Two in-flight `env.AI` calls for
the same beat. Do both `story_draft` responses arrive? Does the UI show
whichever resolves last (natural race, could show the FIRST draft after the
SECOND if the first is slower — confusing but not leak-y) or does the server
need to cancel/ignore stale requests? The spec doesn't pin whether
`generate_story` is a queue-of-one per room (matching the "one generation
per beat" product framing) or genuinely concurrent. Given the per-room rate
limit is stated as "10 generations/minute," concurrent-by-accident seems
plausible and unaddressed. Also unaddressed: what happens to an in-flight
generation if the host disconnects mid-call, or if the underlying game
phase advances past the beat the generation was for (e.g. host taps
generate at `dawn`, is slow, force-advances to `day` before the draft
returns — is a stale `story_draft` for a beat that's no longer current
still delivered and does the UI show it out of context)? Compare to how
`reveal`/`force_advance` pin `stale_advance` via `phaseGen` — `generate_story`
has no phaseGen echo at all, so there's no way to detect/reject a stale
generation server-side. **Fix:** thread `phaseGen` (or a client-minted
`requestId` echoed back) through `generate_story`→`story_draft` and define
the staleness rule (reject/drop drafts for a beat whose phaseGen has since
advanced, mirroring the `reveal` pattern already established).

---

## 7. MAJOR — reconnect / mid-draft host loss is silent

Spec 12 and Spec 01 both treat reconnect as a first-class concern (personalized
snapshot on every reconnect, `WelcomeMessage`). Spec 15's "Open questions"
section doesn't even list reconnect — it's not an open question, it's an
unaddressed requirement. Concretely: the host taps generate, the draft is
mid-flight or has arrived in the host-only panel (client-side state, per the
spec — "draft appears in a host-only panel with [Keep][Re-spin][Discard]"),
then the host's tab reloads or the socket drops and reconnects (this is
explicitly a "product requirement, not just a test convenience" per
CLAUDE.md's verification gates — "multiple tabs of one browser must work").
On reconnect the host gets a fresh `welcome`/`ClientRoomState`. Is the
UNKEPT draft gone? The spec's Memory section implies yes ("Re-spin/Discard
leave memory untouched" — silence on reconnect suggests the draft lives only
in client component state, not `storyState`, so a reload loses it). That may
be an acceptable UX tradeoff (worst case: host re-generates), but it must be
STATED, not left for the implementer to discover — especially because if the
implementer instead decides to persist in-flight/unkept drafts into
`storyState` "to be safe," that's a new leak surface (unkept, possibly still
rate-limit-relevant, generations now living in DO storage) the leak tests
weren't written against.

---

## 8. MINOR — `STORYTELLER_FAKE` env flag naming inconsistent with existing convention; also a config-hygiene item outside implementer's lane

`ALLOW_TEST_SEED` (the one precedent for a test-only env override,
`protocol.ts:88`, `game-room.ts:621`) is described as living in
`wrangler.jsonc`... no — check again: `vitest.workers.config.ts` sets
`ALLOW_TEST_SEED` via the Miniflare bindings override, NOT via
`wrangler.jsonc` (comment explicitly: "Never set in wrangler.jsonc itself").
The spec says `STORYTELLER_FAKE=1` lives in `.dev.vars` — a different
mechanism (dev-only local file) than the precedent's "Miniflare binding
override for pool-workers, absent from wrangler.jsonc entirely." If
`STORYTELLER_FAKE` needs to be true both for pool-workers tests AND for
Playwright against `wrangler dev`, it needs BOTH a Miniflare binding
override (for `npm test`) and a `.dev.vars` entry (for `wrangler dev`) — the
spec only mentions the latter. Not a killer, but will cause the implementer
to wire it once, discover pool-workers tests can't see it, and improvise a
second mechanism ad hoc. Pin both.

---

## 9. MINOR — "15s timeout... no coupling to game phase machinery" is good, but the enforcement mechanism isn't named

"fire on demand only, no alarms involved" is the right call (matches
CLAUDE.md's `setInterval`/alarm-abuse warnings), but a DO's `fetch`/
`webSocketMessage` handler awaiting a 15s `env.AI.run()` call blocks that
handler's synchronous turn semantics in a way worth naming: while the DO is
awaiting the AI call, can it still process OTHER concurrent webSocket
messages from other sockets (game moves, votes)? DOs are single-threaded per
instance but `await` yields the isolate — other queued `webSocketMessage`
invocations CAN interleave during that await. That's actually fine/desired
(game shouldn't stall for AI latency) but the spec's "no coupling to game
phase machinery" should say explicitly "the AI call must not hold any lock/
guard that blocks concurrent game commands during its 15s window" so the
implementer doesn't accidentally serialize game commands behind
`ctx.blockConcurrencyWhile` out of an instinct to "be safe" around the new
async work.

---

## 10. NIT — bible/persona side-channel is asserted safe but not test-scoped

"the bible/memory create a side-channel" risk (per the review brief) — the
spec's leak contract (§4) says leak tests cover "the serialized facts
payload (and the stored memory)" but doesn't explicitly say the tests must
also cover **model OUTPUT** (`bibleUpdates`) before it's folded in on Keep.
A model could, from public-only input, still produce a persona line that
happens to correlate with a real hidden fact by chance/pattern-matching
(e.g., always giving the quietest-voting player a "secretive" persona) —
this is a soft, non-deterministic leak class the spec correctly can't fully
prevent (LLM output is unconstrained prose) but should at minimum note as
an accepted residual risk in the leak contract rather than silence, since
"nothing in any prompt or story ever encodes hidden state" (the Goal
section's stated Done-bar) is a claim about INPUT the spec can enforce, not
about output correlation it can't. Tighten the Goal's wording so "Done"
isn't measured against an unenforceable bar.

---

## 11. NIT — bake-off model list may already be stale

"candidates: the strongest instruct models in the current Workers AI
catalog, e.g. Llama 3.3-70B-class / Llama 4 / GPT-OSS-120B" — fine as
placeholder language but should say "orchestrator confirms current catalog
via Cloudflare docs at bake-off time" explicitly, since this is exactly the
kind of claim CLAUDE.md's context7/docs-first rule exists for (library/API
specifics drift; don't let the implementer hardcode a model id string from
the spec draft without checking Workers AI's current catalog).

---

## Verdict: NEEDS REDESIGN

Findings 1–2 are structural blockers, not fixable with a wording tweak:
(1) the spec's core technical dependency (`env.AI` binding) doesn't exist in
this repo's config yet and isn't scheduled as a prerequisite deliverable, and
(2) the flagship UX moment ("Spin the tale" at a sunrise/sunset hold) is
built on a facts contract that assumes data which, per Spec 12's own
deferred-resolution design, does not exist at that point in the state
machine — the spec needs to split the sunrise/sunset beat into an explicit
pre-reveal "atmosphere" beat (narrow facts: day/phase/roster/bible only) and
treat the actual reveal narration as the existing post-resolution
`dawn`/`dusk` beat, and it needs to say so before this goes to build.
Findings 3–7 (no reusable public-projection function pinned — though the
existing-but-unused `Viewer.kind === "public"` path is a clean fix once
named; no host-broadcast mechanism exists; no field pinned for the
"snapshot-carried" storyState summary; no requestId/staleness contract; no
reconnect story) are all real gaps that would force an implementer to invent
contract exactly the failure class CLAUDE.md's process rules call out
("stacked specs... assuming projection/protocol fields no upstream spec
pinned") — this spec does it to itself, assuming server capabilities
(public-projection helper, host-only broadcast, host-only snapshot field)
that no earlier spec built and this one doesn't design either, just names in
passing. Recommend a v2 draft that: (a) adds the wrangler.jsonc AI binding
as an explicit orchestrator prerequisite, (b) splits the beat set per
finding 2, (c) pins `buildStoryFacts` to call `projectFor(state, {kind:
"public"})` (finding 3), (d) shows the concrete new protocol/type additions
for host-only delivery (findings 5–6), and (e) states the reconnect/lost-
draft behavior (finding 7) — then send back for another adversarial pass
before build.

STATUS: REVIEW COMPLETE

---

## v2 re-review

Second pass against `docs/specs/15-ai-narrator.md` v2 (2026-07-06). Verifying
the fold actually resolves each finding in the real codebase, not just that
the v2 text mentions it.

### Finding 1 (K1 — no `env.AI` binding) — **RESOLVED**

v2 §"Orchestrator prerequisite" pins the exact fix: add `"ai": {"binding":
"AI"}` to wrangler.jsonc, regenerate types, confirm pool-workers picks it up
via the same Miniflare-bindings-override mechanism `ALLOW_TEST_SEED` already
uses (`vitest.workers.config.ts:14-18`, verified this session), verify
`wrangler dev`+deploy before build starts. This is concrete and checked
against the actual precedent. Gates the build correctly (build cannot start
until orchestrator does this). No gap.

### Finding 2 (K2 — sunrise/sunset facts contract) — **RESOLVED**

v2 §"Beats" splits atmosphere (`sunrise-hold`/`sunset-hold`, unresolved
state, no deaths/attack-failed/vote-outcome) from report beats
(`morning-report`/`post-vote`/`epilogue`, resolved state only), with an
explicit legal-phase table (`sunrise-hold→sunrise`, etc.) and a stated
structural guard ("buildStoryFacts... throws/errors on a beat whose phase
can't legally provide its facts — a code guard, not prose"). I checked this
against `machine.ts:334-344` (sunrise/sunset transition without
`resolveNight`/`resolveVote`) again: the split is exactly right — atmosphere
beats read only pre-resolution fields (roster/day/phase), report beats read
post-resolution fields, and the table pins one beat per phase 1:1, so there's
no ambiguity about which contract applies when. The "throws on illegal beat/
phase combo" instruction is a real code-level guard, not just a prose
promise — verifiable by the D-deliverable test list (§Acceptance item 3,
"beat/phase legality table"). One thing to watch at build time, not a spec
hole: the guard needs to check against the CURRENT engine phase at call time
(not a client-claimed phase), which the phaseGen staleness check (M6) already
forces by construction — so the two mechanisms compose correctly. No gap.

### Finding 3 (M3 — public-intersection / `{kind:"public"}`) — **RESOLVED, with a wording nuance**

v2 pins `buildStoryFacts(view, beat)` to take `projectFor(state,
{kind:"public"})` output directly (§Leak contract 1) — exactly the fix I
proposed. Re-checked this session: `Viewer` already includes `{kind:
"public"}` (`game-view.ts:46`), and `projectFor`'s `god` computation
(`project.ts:105`) treats `{kind:"public"}` correctly — `viewerPlayer` is
`undefined` (no player match), so `god` is `true` only at `state.phase ===
"ended"`, never because of the dead-player carve-out (that carve-out only
fires when `viewerPlayer` exists). So the hole my original finding worried
about (an intersection that accidentally rides through the dead-player god
view) genuinely cannot occur via `{kind:"public"}` — it's structurally a
non-dead, non-host viewer.

Correction to v2's framing, not a leak issue: v2's text calls this "the
first real caller of `{kind:"public"}`" — I found on this pass that
`{kind:"public"}` is **already exercised today**, as a same-file spot-check
viewer inside existing leak tests (`test/engine/engine.test.ts:552, 654,
1003, 1257` — join-order regression, no-pending-count checks, rolesRemaining
aggregate checks, watch-target leak checks). It is NOT, however, used by any
production code path to produce a delivered artifact — every real call site
today is `{kind:"host"}` or `{kind:"player",id}` (`game-room.ts:966-971`).
So v2's claim is accurate in the narrow, intended sense (first caller that
turns the projection into something actually shipped to a client/prompt) but
imprecise as written. This is good news, not a hole: it means the branch
already has real test coverage exercising exactly the paths (`god` false
pre-ended, log filtering, rolesRemaining aggregation, watch-target
exclusion) that `buildStoryFacts` will depend on — lower risk than a truly
green-field code path. Recommend a one-line wording fix ("first caller that
delivers the public view as a product artifact, building on existing
same-file test coverage") but this does not block build. No gap in the
underlying design.

### Finding 4 (M4 — vote-outcome publicity) — **RESOLVED**

v2 §"Leak contract 2" now states `voteResolved.eliminatedId`/`.reason` are
ALWAYS public, tallies gated by `votingVisibility === "realtime"` only —
matches `project.ts:141` and `types.ts:41` exactly, and matches
`Interstitial.tsx:62-67`'s unconditional rendering. Correctly fixed, no
remaining mis-gating.

### Finding 5 (M5 — host-only delivery mechanism) — **RESOLVED, verified coherent with `buildStateFor`**

v2 §"Delivery & protocol" now shows the concrete additions: `sendToHostSockets()`
(pattern-matched to the existing `socketsFor` + iterate + send used by
`handleKick`/`handleLeave`, `game-room.ts:527-534, 564-569` — verified this
session, the pattern really does generalize cleanly), and a new
`ClientRoomState.story` field populated by `buildStateFor` "ONLY when
`viewer.kind === "host"`."

I checked this against the actual `buildStateFor` body
(`game-room.ts:942-990`, re-read this session): it already branches per-
viewer for `gameView` (`viewer.kind === "host" ? {kind:"host"} :
{kind:"player",...}`, lines 966-971) and for `pendingRuleset` (lobby-only
null-out, lines 977-979). Adding `story: viewer.kind === "host" ?
<storyState> : null` (or field omission) is a direct, mechanical extension
of an existing, already-precedented pattern in the same function — not a
new architectural shape. v2's claim "this is the FIRST viewer-dependent
field on `ClientRoomState`" is accurate for `ClientRoomState` specifically
(the existing per-viewer branches all live inside the nested `game`/
`pendingRuleset` handling, which are technically already fields OF
`ClientRoomState` that vary per-viewer — so arguably not literally "first,"
but the point that this needs to be deliberate and tested stands regardless
of the precise "first" claim). Multi-host-socket delivery is explicitly
addressed ("sends to ALL host sockets... `hostConnected` is an OR today" —
confirmed at `game-room.ts:950-951`, still just a boolean-OR presence check
today, consistent with v2's framing). No gap.

### Finding 6 (M6 — requestId/phaseGen staleness, races) — **RESOLVED**

v2's protocol block adds `phaseGen` to `generate_story` and `requestId` to
both directions, exactly mirroring the `reveal`/`force_advance` pattern
(`protocol.ts:156-169` — re-checked, both existing messages carry `gen` and
reject on mismatch). v2 states: server rejects on phaseGen mismatch
(`stale_story`) or wrong phase (`wrong_phase`); client drops any
`story_draft` whose phaseGen doesn't match current phaseGen. Queue-of-one
(one in-flight generation per room, `busy` error otherwise) removes the
concurrent-AI-calls race entirely — this is a stronger and simpler fix than
my finding asked for (I only asked for a staleness contract; v2 also
eliminates the concurrency race by construction). Host-disconnect-mid-flight
is addressed: "the call completes into the transient slot; all currently-
connected host sockets receive the draft (or it expires with the beat)."

That said — see Finding 7 below: the phrase "transient slot" here is doing
the same load-bearing work that Finding 7 flags as a genuine remaining gap
(where does that slot physically live, and does it survive a DO eviction
during the up-to-15s AI call). The staleness/requestId/queue-of-one design
itself is sound; its correctness depends on the slot's persistence
mechanism, which is under-specified (see below). Marking M6 RESOLVED on the
protocol/race-logic merits, but flagging the dependency.

### Finding 7 (M7 — reconnect/lost-draft behavior) — **PARTIAL — new issue found**

v2 states unkept drafts are ephemeral by design: "they live in host client
state + a transient in-DO-memory slot for the current beat only — NEVER in
DO storage... Do NOT 'helpfully' persist unkept drafts." This resolves the
narrow question my finding raised (is the behavior stated? yes, explicitly,
and the "don't persist unkept drafts" instinct is correct — it keeps the
leak-test surface from growing for zero product value).

**But it introduces a new problem**: "a transient in-DO-memory slot" is the
literal pattern this codebase's hard rules exist to prevent. `game-room.ts`'s
own header comment (lines 28-29, unchanged, re-read this session): "No
in-memory session state anywhere — everything that must survive
hibernation/eviction lives in `ctx.storage`." `docs/PLAN.md:73` (Connection
layer) states the same principle at the architecture level ("no in-memory
session Map... v0 pinned the DO awake and still lost state" is literally the
failure mode this DO's whole design avoids). A Cloudflare DO can be evicted
between any two `await` points once nothing pins it awake — and an in-flight
`env.AI.run()` call is itself a multi-second `await` (up to 15s per spec),
which is exactly the kind of window where hibernation/eviction can occur
(DOs may hibernate whenever there's no in-progress work AND no open
WebSocket requiring the JS heap — Cloudflare's hibernation model specifically
targets long-idle-but-connected sockets, but process eviction under memory
pressure or a redeploy is a separate, real risk that in-memory-only state
does not survive under any circumstance).

Concretely: if the DO instance is torn down/re-instantiated between
`generate_story` being received and `env.AI.run()` resolving, an in-memory
"queue-of-one busy flag" and an in-memory draft slot both vanish with no
recovery path — the busy flag can never be observed as cleared (a
permanently-stuck "busy" state for that room until some other state change
happens to reset it, which nothing in v2 describes), and a draft that WAS
produced by the (now-orphaned) AI call has nowhere to land — it's not lost
silently to the user (no leak), but it silently breaks the feature (spinner
never resolves, no error surface either, since the error path also needs
the same in-memory correlation to fire `sendToHostSockets`).

This is the same class of bug CLAUDE.md's hard rules were written against
("`setInterval` in the DO" / "in-memory session Maps" are named explicitly
as retired v0 patterns not to resurrect) — v2 re-introduces the pattern in a
new spot while explicitly avoiding it in the old spot (unkept drafts
correctly go to client-state-not-storage, but the *in-flight coordination
state* went to DO-memory instead of `ctx.storage`).

**Fix:** the queue-of-one flag and the pending-request correlation
(requestId → which beat/phaseGen is in flight) need to live in `ctx.storage`
(a small, ephemeral-but-durable key — e.g. `STORY_INFLIGHT_KEY: {requestId,
beat, phaseGen, startedAt}`), written before the `env.AI.run()` call and
cleared after, mirroring exactly how `GAME_DEADLINE_KEY` already coordinates
an async, time-bounded operation across potential DO restarts
(`game-room.ts:69, 783-786, 877-890` — the alarm-driven deadline pattern is
the precedent to reuse, not invent fresh). A stale in-flight record past
some bound (e.g. 20s, comfortably past the 15s AI timeout) should be treated
as failed/clearable on the next `generate_story` attempt, the same way a
stale alarm is tolerated today. The draft TEXT itself can still stay
memory-only-until-delivered (that part is fine, since delivery happens
synchronously within the same `env.AI.run()`-awaiting handler turn, no
separate persistence needed for the text — only the *coordination flag* needs
durability). Not a leak-severity issue (nothing reaches a wrong viewer), but
a real robustness/hang class the spec must fix before build — recommend
MAJOR, not KILLER, since the failure mode is "feature silently hangs for one
room," not a security or game-correctness break, and force-advance/reveal
etc. are entirely unaffected (the AI call has "no coupling to game phase
machinery" per m9, confirmed still true).

### Finding 8 (m8 — STORYTELLER_FAKE dual wiring) — **RESOLVED**

v2 §"Dev/test wiring" pins both mechanisms explicitly and correctly:
Miniflare `bindings` override in `vitest.workers.config.ts` (same as
`ALLOW_TEST_SEED`, re-verified this session at `vitest.workers.config.ts:14-18`)
for pool-workers, `.dev.vars` for `wrangler dev`/Playwright. No gap.

### Finding 9 (m9 — DO concurrency during AI await) — **RESOLVED**

v2 explicitly states no `blockConcurrencyWhile` around the AI await, and
that concurrent game messages must interleave freely. Correct and matches
the only existing use of `blockConcurrencyWhile` in the file being scoped
to the constructor's alarm-recovery guard only (`game-room.ts:123-128`), not
a pattern this spec's code should extend. No gap.

### Finding 10 (m10 — output-correlation residual risk) — **RESOLVED**

v2's Goal section now states the enforceable bar is input-side only, and
§Leak contract 7 explicitly names and accepts the output-correlation
residual risk with a stated rationale (narrator-eyes-only + human filtering).
This is honest scoping, not a fixable leak — appropriately handled as an
accepted risk rather than a false "Done" claim. No gap.

### Finding 11 (m11 — bake-off catalog staleness) — **RESOLVED**

v2's bake-off section now explicitly instructs the orchestrator to confirm
the current Workers AI catalog from live docs at build time rather than
trusting the draft's model list. No gap.

### New issues introduced by v2 (beyond Finding 7 above)

- **Minor, not blocking:** v2 doesn't state when `storyState` is first
  initialized in DO storage — at room-claim time (mirroring
  `PENDING_RULESET_KEY`, set eagerly in `handleClaim`,
  `game-room.ts:174-195`) or lazily on first `set_story_settings`/
  `generate_story`. Doesn't matter for leak-safety (either way `story` is
  `null`/absent for players and the OFF-by-default rule is server-enforced),
  but the implementer will need to pick one, and `buildStateFor` reading a
  possibly-undefined storage key needs a defined fallback (`{enabled:false,
  ...}` vs `null`) for the pre-first-use case, or Playwright's E2E
  assertion "player client asserts zero story surface the whole game" needs
  to also hold true against a brand-new room where `set_story_settings` was
  never called. Recommend the implementer default it exactly like
  `PENDING_RULESET_KEY` (eager init at claim time to a disabled default) —
  simplest and matches precedent. Not a blocking finding, just flag it so
  the implementer doesn't have to invent the answer mid-build.

## v2 verdict: NEEDS ANOTHER PASS (narrow)

10 of 11 original findings are fully RESOLVED, verified against the actual
code (not just against the spec's restated claims) — the fold work is
high-quality and the K1/K2 structural fixes in particular hold up under
re-scrutiny. The one remaining item, Finding 7 (M7), is PARTIAL: it correctly
fixed the narrow question I raised (is reconnect/lost-draft behavior stated?)
but the mechanism it introduces to do so — an in-DO-memory coordination slot
for the queue-of-one flag and in-flight request correlation — reintroduces
the exact "in-memory session state that doesn't survive hibernation/
eviction" anti-pattern this codebase's hard rules and Spec 01's architecture
were built to eliminate. This is a MAJOR-severity robustness gap (rooms can
get stuck with a permanently-"busy" storyteller after a DO restart
mid-generation), not a leak, and it has a narrow, mechanical fix (move the
queue-of-one/in-flight-correlation flag to `ctx.storage`, reusing the
`GAME_DEADLINE_KEY` async-coordination pattern already established in this
same file — the draft TEXT itself can stay ephemeral/memory-only as
designed). Recommend: fold this one fix, then this spec is BUILDABLE — no
third full adversarial pass needed, a targeted verification that the
storage-key design lands correctly is sufficient.

STATUS: RE-REVIEW COMPLETE
