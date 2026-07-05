# Spec 10 — "Case File" visual identity (full redesign)

**v1 — 2026-07-05 · Status: approved for build**
Parent: Tanner picked Direction II (Case File) from the design lookbook after
the Spec 09 polish read as "too similar to before — I want an actual change
in design." This SUPERSEDES Spec 09's timid atmospheric layer: keep Spec 09's
shadcn component *infrastructure* (Card/Badge/Separator/Button primitives,
cn() on cva+clsx+tailwind-merge) but re-skin it entirely into the Case File
identity. Depends on: shipped app (specs 00–08), Spec 09 primitives.
**Presentation + copy identity only** — no game logic/protocol/engine change.

## Goal

Transform the look from "generic dark app" into a **1940s detective's case
file / pulp-noir dossier** — a genuinely different visual identity the user
feels immediately, while keeping the game's structure, controls, and
behavior. Done looks like: a screenshot tour where every screen reads as
pages from a criminal investigation file, not a restyled web app; and the
suite still proves behavior (testids unchanged; only deliberately-themed
copy strings and their few asserting tests change, documented).

## The identity (this is the point — commit to it)

- **Palette** (semantic, not decorative):
  - `paper` — aged manila/kraft `#d8c69a` (primary "typed on paper" text/
    surfaces) and a lighter `#e7dcc0` for emphasis.
  - `ink` grounds — near-black desk `#0d0c0a`, file-shadow `#15130f`,
    raised `#1c1a15`. Borders = `#3d382c` (worn) / dashed for file frames.
  - `stamp` red `#a01e1e` — danger/alert/mafia/DECEASED/selected-kill ONLY
    (it's the rubber-stamp ink; never a general accent).
  - `faded` `#9a8f76` — secondary/metadata/"// comment" labels.
  - Optional evidence-tab accents may use a muted olive `#6e6450`.
  - Keep it legible in a dim room: dark ground, warm paper text.
- **Typography** — the biggest lever:
  - **Monospace typewriter is the primary voice** everywhere (system stack:
    `ui-monospace, "SFMono-Regular", "Courier New", monospace`) — labels,
    body, lists, buttons. This instantly reads "case file". Retire Playfair
    as the default; it's too elegant for this world. (You MAY keep one
    heavy display face for the biggest dramatic headline moments — a
    condensed bold — but mono is the default and dominant voice.)
  - Uppercase + wide letter-spacing for labels and stamps; `// ` prefixes
    for helper/metadata lines; tabular-nums for any counts/timers.
- **Motifs (the identity carriers — use them, tastefully, everywhere):**
  - **Rubber stamps**: rotated, bordered, stamp-red or faded, e.g.
    `CONFIDENTIAL` (host screen), `DECEASED` (dead players), `CLEARED` /
    `SUSPECT`, `CASE CLOSED` (game end). Slightly rough, ~-6° rotation.
  - **Redaction bars**: solid black bars over hidden information — the
    perfect metaphor for hidden roles, hidden votes (votingVisibility:
    hidden), and un-revealed picks. A villager's unknown role, a teammate
    still "deciding", the tally under hidden voting → redaction bars.
  - **Dossier framing**: dashed/ruled file borders, file-tab headers
    (a labeled tab on a card, e.g. "SUBJECT 04 — CAROL"), `FILE #` +
    day number eyebrows, monospace field rows (`FIELD ......... value`
    with dot leaders).
  - Subtle **paper texture** (very low-opacity noise/fiber, inline SVG, a
    faint warm cast) over the dark ground — reuse Spec 09's GrainOverlay
    mechanism, retuned warmer. `pointer-events:none` (hard rule below).
  - Optional: perforated/torn edges on interstitials, paperclip on the
    role card, typewriter "struck" heading treatment.
- **Thematic copy** (allowed, and part of the identity — but see testid rule):
  players are "SUBJECTS", the mafia is "THE SYNDICATE", night vote =
  "WHO DIES TONIGHT? — mark one suspect", day vote = the interrogation/
  accusation, dead = "DECEASED / CASE CLOSED", the log = the "CASE LOG".
  Keep it punchy and period, never cutesy.

## Hard constraints (unchanged from Spec 09 — violating any is a build failure)

- **Preserve EVERY `data-testid`** and asserted attribute (`data-phase`,
  `data-tint`, `data-consensus-reached`, `data-revealed`, etc.). Restyle
  appearance + thematic copy; keep the interaction contract. Testid set must
  remain a superset (no removals/renames). A testid-diff gate stays empty.
- **Copy vs tests**: you MAY change visible strings for the identity, but if
  a test asserts on a string you change (e.g. a heading or helper text), you
  must UPDATE that test in the same change and note it. Do NOT change strings
  that are load-bearing game state the tests key on unless clearly cosmetic.
  Prefer: keep functional control labels the tests assert (Start game, Lock
  in, Join, Vote targets) recognizable; express theme in headings, eyebrows,
  section labels, and ornament. Minimize test churn; document every test
  edit.
- **Decorative layers MUST be `pointer-events:none`** and behind interactive
  content (stamps, redaction overlays, paper texture, torn edges). This is
  the tap-eating bug class — verified by real-click on every screen.
- **No external requests**: paper texture = inline SVG/CSS; fonts = system
  mono stack (no webfont URL, no CDN). Grep gate stays clean.
- **Respect `prefers-reduced-motion`**; preserve Spec 04's interruptible
  ~300ms phase-transition contract; mobile-first 390×844, ≥44px targets,
  safe-area, no horizontal scroll.
- Dependency budget: no new runtime deps (reuse Spec 09's cva/clsx/
  tailwind-merge + Radix/vaul/sonner). Bundle delta recorded.

## Deliverables

- **D1 — identity foundation**: rework `index.css` `@theme` to the Case File
  palette + mono type tokens (retire Playfair as default; keep it only if
  used for a deliberate display moment); retune GrainOverlay to warm paper
  texture; add reusable primitives for the motifs — a `<Stamp>` component
  (variants: confidential/deceased/cleared/suspect/case-closed), a
  `<Redaction>` bar, a dossier `<FileCard>` (framed card with optional tab
  label) and `<FieldRow>` (dot-leader label→value). Re-skin the Spec 09
  Button/Badge/Card to the dossier look.
- **D2 — apply across EVERY screen** (this is a full redesign, not spot
  fixes — every screen must read as case-file): Home, Lobby (player),
  HostLobby (CONFIDENTIAL stamp, file header), RoleReveal + MyRole (a
  dossier role card, paperclip, the role as a "classified assignment"),
  Night drawer (WHO DIES TONIGHT, suspect list, redaction on undecided
  teammates, syndicate picks), Dawn/Dusk interstitials (typed bulletin /
  torn-edge report), Day/Voting (interrogation board; hidden tally =
  redaction bars; runoff), DeadGodView + dead players (DECEASED stamp,
  full unredacted file), GameEnd (CASE CLOSED, verdict), HostGame (the
  investigator's board: subject dossiers with role badges + status stamps,
  case log, controls), ConnectionBanner, ManualShareLink, IdentityChooser,
  Instructions (as a "how this case works" briefing). Consistent dossier
  vocabulary throughout.
- **D3 — verification**: unit/integration suites green; E2E green with
  MINIMAL, documented test edits (only where themed copy changed a string a
  test asserted); testid-diff empty; grep gates (no external assets;
  pointer-events:none on every decorative layer). Bundle delta recorded.

## Acceptance criteria

CI: typecheck; engine/client/server unit suites green; E2E green (list any
test edited and why — copy-only); testid superset preserved; grep gates pass.
Live (orchestrator): full screenshot tour of EVERY screen (390×844 + host
1024) — must read unmistakably as a detective case file, cohesive across
screens; real-click every primary control (no decorative layer eats taps);
a full game played through the redesigned UI.

## Notes for implementer

- Commit to the identity — half-measures are what got rejected last round.
  Every screen should make someone think "this is a case file" within a
  second. But stay legible and usable on a phone in a dim room.
- The redaction-bar metaphor is your strongest tool — use it wherever the
  game hides information (unknown roles, hidden votes, undecided teammates,
  the tally before dusk). It's thematic AND functionally honest.
- Behavior/testids are frozen; identity is wide open. If tempted to change a
  testid to theme something, don't — theme the surrounding markup instead.
- Deviations → `docs/specs/10-implementation-notes.md`, end with a STATUS
  line. Do not commit or deploy (orchestrator owns those).
