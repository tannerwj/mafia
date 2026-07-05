# Spec 10 — "Case File" visual identity: implementation notes

Full visual redesign into a 1940s detective's **case file / pulp-noir dossier**.
Presentation + copy identity only — no game logic, protocol, engine,
projection, or behavior change. Spec 09's shadcn component *infrastructure*
(Card/Badge/Separator/Button, `cn()` on cva+clsx+tailwind-merge, GrainOverlay)
is KEPT and re-skinned entirely; the Spec 09 *look* is gone.

## Identity foundation (D1)

### Palette + type (`index.css` `@theme`)

Reworked to the Case File semantic palette. Token *names* were deliberately
kept (`ink`/`ink-2`/`ink-3`, `bone`, `smoke`, `blood`, `brass`) so ~25 call
sites re-skin in place with zero churn — only their VALUES changed:

| token         | before (noir)     | after (case file)                     |
| ------------- | ----------------- | ------------------------------------- |
| `--color-ink` | `#0c0a09`         | `#0d0c0a` near-black desk             |
| `--color-ink-2` | `#1c1917`       | `#15130f` file-shadow surface         |
| `--color-ink-3` | `#292524`       | `#1c1a15` raised paper-on-desk        |
| `--color-paper` (new) | —           | `#d8c69a` manila body text/surface    |
| `--color-bone`  | `#e7e5e4`       | `#e7dcc0` lighter emphasis paper      |
| `--color-smoke` | `#44403c`       | `#9a8f76` faded metadata / `//` lines |
| `--color-blood` | `#991b1b`       | `#a01e1e` rubber-stamp red            |
| `--color-brass` | `#ca8a04` gold  | `#8a7d4e` muted evidence-tab olive    |
| `--color-brass-hi` (new) | —      | `#b7a86a` brighter olive for labels   |
| `--color-frame` (new) | —           | `#3d382c` worn file-frame border      |

- **Typography retired Playfair entirely.** The primary + display voice is now
  the **system monospace stack** (`ui-monospace, "SFMono-Regular", … ,
  "Courier New", monospace`) — a typewriter voice everywhere. There is no
  webfont: `--font-display` maps to the same mono stack and the "display"
  drama comes from the `.file-heading` utility (weight 800 + tight tracking +
  uppercase), not a downloaded face. The `@fontsource-variable/playfair-display`
  dependency and its `@import` were removed — dropping ~90 kB of woff2 subsets
  from the built assets.
- Radii tightened (`--radius-lg` 0.25rem, `--radius-md` 0.1875rem) — files have
  crisp near-square corners, not pills.

### Motif utilities + primitives

- CSS utilities in `index.css`: `.stamp` (+ `.stamp-red/-olive/-faded`) rubber
  stamp, `.file-heading` struck typewriter headline, `.redaction` marker-strike
  bar, `.file-frame` dashed file border, `.field-leader` dot-leader, `.file-torn`
  perforated report edge (decorative `::before`, `pointer-events:none`).
- New primitive module `components/ui/dossier.tsx`:
  - `<Stamp variant=…>` — confidential / deceased / cleared / suspect /
    case-closed. `decorative` prop adds `pointer-events-none` for overlay use.
  - `<Redaction width label>` — a solid marker bar that *replaces* hidden text
    (the secret is never rendered underneath — honest, not just visual).
  - `<FileCard tab=…>` — dossier sheet with an optional labeled file tab.
  - `<FieldRow label value>` — `LABEL …… value` dot-leader row.
  - `<CommentLine>` — `// …` faded metadata line.
- Re-skinned Spec 09 primitives (variant/size KEYS unchanged → call sites +
  button-text assertions untouched): **Button** (crisp corners, uppercase mono,
  `brass`=olive primary), **Badge** (squared file-tag chip; lowercase variant
  keys KEPT for the privacy scan), **Card** (`file-frame`-style border,
  `file-heading` title), **Separator** (frame color).
- **GrainOverlay** retuned to warm paper texture: same inline-SVG feTurbulence
  `data:` URI (no external request), now `mix-blend-mode: soft-light` with a
  warm cast + a `::after` warm-vignette layer. Still `pointer-events:none`,
  `aria-hidden`, mounted once at app root.

## Applied across every screen (D2)

Every screen now reads as a case-file page, with a consistent dossier
vocabulary (FILE eyebrows, `//` helper lines, stamps, redaction, dot-leaders):

- **Home** — "Case File No. 187", struck `MAFIA` headline, CONFIDENTIAL stamp;
  "Open a new case" / "Pull the file" / file-reference-number input.
- **Lobby (player)** — "The Roster", subjects-on-file `FileCard` with numbered
  rows; "Open the case".
- **SeatPicker / IdentityChooser** — register/sign-in framing; "The
  Investigator" vs "Subject: {name}".
- **Room** (kicked / host-recovery / manual-share / connecting) — CASE CLOSED
  stamp, "Resume the case?", `//` copy.
- **RoleReveal + MyRole + HoldToPeek** — a "CLASSIFIED ASSIGNMENT" dossier role
  card with a paperclip; HoldToPeek is a 🔍 magnifier; MyRole button is a "My
  File" 🗂 file tab. Role displayName strings unchanged (privacy + assertions).
- **NightActionDrawer** — per-role headings ("Who dies tonight?" / "Night
  interrogation" / "Protective detail"), numbered suspect list with a "marked"
  tag on the selected mark, **redaction bars over undecided teammates** (with the
  honest "deciding…" label kept), Syndicate roster, stamped "Filed" waiting
  state.
- **Interstitial** — a typed torn-edge report sheet (dawn/nightfall bulletin).
- **DayVoting** — interrogation board; selected accusation gets an `✗`; hidden
  tally shows a **redaction bar + sealed "N of M have voted" count**; "No case
  tonight" spare option; "Withdraw my accusation".
- **DeadGodView** — DECEASED stamp, "the unsealed file — every subject", "Case
  log".
- **GameEnd / HostGameEnd** — CASE CLOSED stamp + "Verdict: …" splash, "the
  unsealed file", "Open a new case".
- **HostLobby** — "The Case Room" + CONFIDENTIAL stamp, `FieldRow` case
  parameters card, "Subjects" table.
- **HostGame** — "The Case Board": subject-dossier table with role badges +
  status stamps, phase header, "Case log", investigator controls.
- **PlayerTable / PrivacyChip / HostLog / DeadlineCountdown / ConnectionBanner**
  — dossier surfaces, "eyes only" privacy chip, "Case log", tabular-nums
  countdown, "Line dropped — redialing…" banner.
- **Instructions** — "Case briefing"; section titles "Objective" and "Mafia
  lock-in" KEPT verbatim (asserted); 6 role entries unchanged.

## Test edits (D3)

**Zero test edits.** Every string a test asserts was preserved verbatim:

- Role display names (`Detective`/`Mafia`/`Angel`/`Suicide Bomber`) come from
  the untouched `roleCopy.ts` — kept for both the assertions and the
  player-privacy innerHTML scan.
- `winnerLabel` rephrased to "Verdict: the village prevails" / "the suicide
  bomber wins alone" / "the mafia prevails" — still contains the asserted
  substrings `village` / `bomber` / `mafia`.
- Kept verbatim: `Start game` (exact `toHaveText`) + `Need at least N players`;
  `Lock in` / `Unlock`; `mafia-consensus` "N of M locked"; `mafia-teammate-picks`
  "deciding"; `vote-tally` "N of M have voted" / "Votes are visible in real
  time"; interstitial "The attack failed." + death lines; `Rejoin as {name}`;
  Instructions "Objective" / "Mafia lock-in"; host-log `describe()` output
  ("failed", role ids); `phaseLabel` words; `forceAdvanceCopy` "abstain";
  store toast "already moved".
- The reconnect E2E (`game-reconnect.spec.ts`) asserts the restored night pick
  has class `border-brass` — the selected `night-target-option` KEEPS
  `border-brass`, so no edit was needed.

## Verification (D3)

- **Testid diff gate: empty.** HEAD (Spec 08) vs current working tree — no
  testid removed or renamed (the only diff entries are the `$testId` template
  placeholder in ConfirmDialog, present identically in both). Testid set is a
  superset (all 58 asserted testids resolve).
- **typecheck**: clean (`tsc --build --force`).
- **Unit suites**: engine 40, client 10, server 40 — all green, zero edits.
- **E2E** (`--workers=1`): 32 passed (3.4m), zero test edits.
- **Grep gates**: no `fonts.googleapis` / `cdn.` / external `http(s)` asset
  refs in `src` or `index.html`; `pointer-events:none` present on every
  decorative layer (`.grain-overlay` + its `::after`, `.phase-ambiance`,
  `.file-torn::before`, and `<Stamp decorative>`); no `font-display` class
  usages remain (only the CSS token, a mono stack).

## Bundle delta (cost-awareness)

`vite build` — Spec 09 baseline (committed working tree state) vs this redesign:

| Asset      | Baseline (raw / gzip)  | Case File (raw / gzip) | Delta (raw / gzip)   |
| ---------- | ---------------------- | ---------------------- | -------------------- |
| client JS  | 380.51 kB / 115.60 kB  | 387.11 kB / 117.28 kB  | +6.60 kB / +1.68 kB  |
| client CSS | 26.92 kB / 6.38 kB     | 27.67 kB / 6.44 kB     | +0.75 kB / +0.06 kB  |
| fonts      | ~90 kB woff2 (4 subsets) | 0 (Playfair removed) | **−~90 kB**          |

JS grew slightly (the dossier primitives). CSS grew marginally (motif
utilities). **Net transferred payload is ~90 kB smaller** — the Playfair
webfont subsets are gone; the identity uses only the system mono stack.

## No new runtime deps

Reused cva / clsx / tailwind-merge + Radix / vaul / sonner. Removed one
dependency (`@fontsource-variable/playfair-display`). No additions.

STATUS: complete, suites green
