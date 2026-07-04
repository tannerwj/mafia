# Spec 06 — Ruleset editor & presets

**v2 — 2026-07-04 · Status: approved for build**
*v2 folds in all findings from Codex adversarial review (2026-07-04):
balance caution defanged (v1 fired on house defaults for N=3–9 — reviewer
ran the table), majority-with-abstentions pinned via Spec 02 v2.4,
validateRuleset signature pinned, coercePreset deliverable added (the drift
tolerance previously named a mechanism that didn't exist), formal Spec 01
amendment language, set_ruleset excluded from lastActivityAt, debounce race
+ broadcast-per-edit stated as accepted tradeoffs, 5s E2E timer, reserved
preset name, rejection-channel pin, closed-setup retrofit note. No findings
overruled.*
Parent: PLAN.md §Roadmap 06. Depends on: Specs 02 (Ruleset schema,
validateRuleset), 03 (start_game), 05 (host lobby it embeds into).
House six only (v1.1 role packs are out of scope but the editor must not
hardcode against them).

## Goal

The host shapes the game without touching defaults they don't care about:
an editor in the host lobby over every `Ruleset` field — role counts,
timers, tie policy, consensus mode, reveal policy, voting visibility —
with inline validation, a live balance hint, and nameable presets saved on
the host's device. Done looks like: Playwright configures a non-default
ruleset (2 mafia, minion on, majority threshold, hidden voting, 60s day
timer), plays it, and every configured rule observably governs the game;
presets round-trip across a page reload.

## Non-goals

Server-side preset storage or preset sharing (v1.1). New engine rule fields.
Role packs. Per-player role assignment overrides ("make Bob the mafia" —
never: the app's integrity IS the shuffle).

## Pinned conventions

- **The editor is schema-driven from `Ruleset`** (Spec 02 D1) — field
  groups: Roles (mafia count `auto|1..n` + formula display, detective count,
  angel count, suicide bomber / minion toggles), Pace (per-phase timers
  incl. "no timer", dawn/dusk beat), Votes (threshold, tie policy,
  no-murder option, voting visibility), Flow (first-night kill, reveal on
  death, parity rule, mafia consensus). Every control shows the house
  default state visibly (a "house rules" chip when untouched; "modified"
  accent when not).
- **Validation is `validateRuleset` output, rendered** — errors (red,
  block start, attached to the offending control), warnings (brass,
  non-blocking — e.g. the all-timers-absent warning from Spec 03). The
  client never re-implements validation logic; it renders the engine's
  structured errors (the engine is imported client-side for this — it's
  pure TS by construction, same code both sides).
- **Balance hint**: informational line under Roles — "recommended mafia
  for N players: √N ≈ K" (research: docs/research/mafia-rules-research.md
  §4). A brass caution appears ONLY when the host has manually set counts
  AND mafia deviates from K by ≥2 — never on `auto`/house defaults (v1's
  additional `⌈N/3⌉` clause fired on untouched house rules for every N in
  3–9, training hosts to ignore warnings; dropped). Sanity table (auto,
  minion off): N=5→K=2, N=9→K=3, N=12→K=3 — caution silent in all.
  Never blocks — the host is sovereign.
- **Live re-validation** on player join/leave (counts change N) — the
  start button gate re-evaluates; an editor open when N changes updates
  its hint and errors in place.
- **Presets**: `localStorage['mafia:presets']` — named, host-device-local:
  `{name, ruleset, savedAt}[]`; save (name prompt, overwrite-by-name; the
  name "House rules" is reserved case-insensitively — save rejects it),
  load (applies to editor state, marks modified-vs-house), delete. "House
  rules" is always the first, undeletable entry (constant, not stored).
  Schema drift is handled by a named mechanism, **`coercePreset(raw:
  unknown, house: Ruleset): Ruleset`** (D3): per-field runtime type +
  enum-membership check against HOUSE_RULES's shape — failures take the
  house value; unknown keys dropped; result then goes through
  `validateRuleset` (which is semantic-only per Spec 02 v2.4 — shape
  coercion is precisely this function's job, not a duplicate of
  validation). Never crashes on any stored bytes.
- **Players see the rules**: the player lobby (Spec 04) gains a read-only
  "tonight's rules" summary card — enabled roles + counts and any
  non-default modifiers (open setup is the house way; a closed-setup
  option is v1.1). The card renders from the same ruleset the host will
  send — broadcast in the lobby snapshot as `pendingRuleset` when the host
  edits (debounced 500ms), so players watch the rules take shape.
- The editor UI is a Spec 04-style bottom-sheet/inline hybrid: groups
  collapse; mobile-first; noir tokens; no new dependencies.

## Deliverables

**D1 — protocol**: `set_ruleset {ruleset}` (host, lobby only, debounced
client-side) → validated, stored as the room's pending ruleset, broadcast
in lobby snapshots as `pendingRuleset`. **This formally amends Spec 01 D1:
`ClientRoomState` gains `pendingRuleset: Ruleset | null`.** Invalid edits
get `rejection{code:'invalid_ruleset', errors}` to the sending host socket
only (Spec 03's channel and code, socket stays open); previous pending
stands. `set_ruleset` does NOT bump `lastActivityAt` (same exclusion as
`ping` — an idle host fiddling with sliders must not immortalize an empty
lobby). `start_game` continues to carry the full ruleset (the editor's
current live state). **Accepted tradeoffs, stated**: (a) the 500ms debounce
means a player's rules card can lag the editor by one interval — if
`start_game` wins that race, the card was stale for <500ms and is
superseded by the game snapshot; cosmetic only, never a fairness/leak
issue. (b) There is no DO-side edit throttle beyond per-message processing;
each accepted edit re-broadcasts to all sockets — fine at party scale
(≤20), revisit only if real rooms show otherwise.

**D2 — editor UI** (`src/client/screens/host/RulesetEditor`): field groups,
house-default chips, validation rendering, balance hint, live N updates.

**D3 — presets**: storage, save/load/delete UI, schema-drift tolerance.

**D4 — player summary card** (Spec 04 lobby): renders `pendingRuleset`.

**D5 — tests**:
- Playwright: non-default game end-to-end (2 mafia, minion, majority
  threshold, hidden voting, **5s** day timer — the pinned floor; real 60s
  waits are suite poison, and "renders a long countdown correctly" is
  asserted from `deadlineAt` in the snapshot without waiting it out) —
  each configured rule asserted observable in play (hidden mode shows
  counts not names; **majority threshold: 2 votes of 5 living does NOT
  eliminate** — Spec 02 v2.4 fixed-denominator pin; countdown visible and
  phase auto-advances at expiry).
- Editor: error blocks start (mafia count > players); warning doesn't
  block; house chip ↔ modified accent; N change re-validates live.
- Presets: save → reload page → load → editor state identical; corrupt/
  stale preset JSON → falls back gracefully (dropped/filled/validated).
- Player card: host edits → card updates; player never gains edit
  affordances.

## Acceptance criteria

CI: D5 green; typecheck; zero new dependencies (jq gate unchanged);
`grep -rn "validateRuleset" src/client` shows rendering only (no local
validation logic beyond calling the engine function).
Live (orchestrator): configure and play a heavily-modified game multi-tab;
screenshots of the editor at 390px; preset round-trip on a real phone
viewport.

## Notes for implementer

- The engine import into the client must not drag DO/server code with it —
  `src/engine` is pure TS by spec; if the bundle graph says otherwise,
  that's an engine layering bug to report, not work around.
- `pendingRuleset` is lobby-phase state (Spec 01 storage), not GameState.
- Future-spec flag: `pendingRuleset` bypasses `projectFor` (it's lobby
  state, pre-game). If v1.1 adds closed setups, its visibility must be
  retrofitted through projection — whoever writes that spec inherits this.
- Deviations → `docs/specs/06-implementation-notes.md`.
