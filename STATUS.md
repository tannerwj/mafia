# STATUS — append-only breadcrumbs

## 2026-07-04 — Project reboot
- Reviewed v0 (Workers+DO, vanilla JS). Root causes of brittleness identified:
  mid-game rejoin refused (`handleJoinGame` lobby-only), identity tied to
  ephemeral session IDs (incl. host takeover hole), global localStorage keys
  (breaks multi-tab), no DO hibernation (evictions dropped all sessions),
  client-authoritative role state, consensus deadlocks (no timers/override),
  tie/runoff + discussion timer never built, name-injection XSS, zero tests.
- Tanner decisions: full rewrite incl. UI · TypeScript everywhere · CF
  Workers+DO stays · host = arbitrator only · timers + host force-advance ·
  noir/speakeasy art direction · React+Vite+Tailwind4, shadcn selectively.
- Wrote docs/PLAN.md (architecture + roadmap, specs 00–07), CLAUDE.md
  (operating rules), this file. Task board mirrors the roadmap.
- Rules/roles web research running (background agent) → feeds Specs 02/06.
- Next: Spec 00 scaffold (orchestrator-built), Spec 01 written + adversarially
  reviewed.

## 2026-07-04 — Research folded, v1 scope locked
- Rules research delivered → docs/research/mafia-rules-research.md. Engine
  pins adopted into PLAN.md: NAR resolution ladder, ToS attack/defense tiers,
  √n mafia default, per-action auto-default on timer expiry.
- Tanner: v1 roles = house six only (packs → v1.1, engine schema must still
  support them); dead players get god view, no chat; E2E = Playwright
  multi-context suites + Chrome DevTools MCP live runs (plugin installed).
- Spec 01 drafted (docs/specs/01-*.md); Codex adversarial review in flight.
- Spec 00 scaffold build in flight (claude subagent, networked).

## 2026-07-04 — Spec 01 v2 after adversarial review
- Codex review returned 2 BLOCKER / 3 SHOULD-FIX / 3 CONSIDER; all folded, none
  overruled. Highlights: room-claim protocol (idFromName has no existence
  concept — claim = DO storage check), unified single-slot alarm scheduler
  (auth-reap 30s + empty-lobby 1h + absolute TTL 6h through one
  scheduleNextAlarm(); never wipe while any socket lives — the everyone's-
  phone-locked case is protected), 4002 reclassified retryable (only
  4001/4003 terminal), wall-clock liveness with resume-path as primary
  defense (mobile timer throttling), multi-seat localStorage backups for
  shared devices, kick atomicity pinned.
- Spec 01 v2 approved for build. Blocked on Spec 00 scaffold completion.

## 2026-07-04 — Spec 00 closed, Spec 01 building, Spec 02 in review
- Scaffold verified independently (typecheck, engine+DO tests, Playwright
  ping-pong E2E, build) and committed as fa15e66. Notable: vitest-pool-workers
  0.18 uses a `cloudflareTest` Vite plugin (docs drift), plugin-react pinned
  5.x for Vite 7, workers-types pinned ^4 for wrangler peer.
- Spec 01 v2 handed to Codex for implementation (spec01-build, background).
- Spec 02 (engine core) drafted: NAR bands, attack/defense tiers, rngState in
  GameState, abstain-vs-no_murder semantics, house-six pins (detectives/
  angels independent — deliberate v0 change; mafiaConsensus applies to mafia
  only), Godfather/Jester fixtures as extensibility proof. Codex adversarial
  review in flight (spec02-review).

## 2026-07-04 — Spec 02 v2 after adversarial review
- Review: 4 BLOCKER / 4 SHOULD-FIX / 5 CONSIDER; all folded, none overruled.
  Big ones: village win now requires minions dead too (design.md rule; both
  v0 code and the v1 draft had the mafia-only bug — review caught a real
  house-rules contradiction); mafia consensus timeout resolves as plurality
  of submitted mafia votes (generic no-action default would have neutered
  unanimous mode); elimination parityRule got an anti-stall backstop with a
  worked 1v1 example; runoff pins (no_murder never in runoffs, tied runoff →
  peace, never re-runoff); protection = band-300 state mutation read by
  band-400 kills which always emit attackAttempted (band 450 reserved for
  v1.1 reactive roles); dead god view delayed to resolution boundaries
  (physical-proximity leak — host stays live); hidden voting omits vote
  events from living projections; Escort fixture added (band-200 coverage).
- Spec 02 v2 approved for build. Build starts when Spec 01 lands (same
  worktree — builds are sequential).

## 2026-07-04 — Spec 03 v2 after adversarial review
- Review: 7 BLOCKER / 3 SHOULD-FIX / 2 CONSIDER; all folded, none overruled.
  The alarm-idempotency design was incoherent: CF `alarm()` carries no
  payload, my staleness check referenced a GameState field that didn't
  exist, AND violated the spec's own opacity pin. v2 model: fire-time
  fresh-read + due-time check in the DO, `at === state.deadlineAt`
  validation inside the engine (Spec 02 amended to v2.1 adding `deadlineAt`).
  Also: constructor wake-recovery guard (crash window between persisting a
  deadline and arming the alarm could kill a game's timer forever — verify
  Spec 01's impl for the same hole during its verification), pool-workers
  WS+DO isolation limitation → spike-first go/no-go gate in D4 with a
  Playwright fallback, `rejection` declared as formal Spec 01 protocol
  amendment, players-merge + join-order pins, abandoned-room 6h-TTL
  tradeoff stated with a validateRuleset warning for fully-untimed rulesets.
- Specs 01/02/03 all review-hardened and approved. Waiting on spec01-build.

## 2026-07-04 — Spec 04 v2 after adversarial review
- Review: 4 BLOCKER / 6 SHOULD-FIX / 4 CONSIDER; all folded, none overruled.
  The blocker class was cross-spec seam holes: four UI features assumed
  projection fields no spec defined. Spec 02 → v2.2 pins the per-player
  projection contract (mafia live factionVotes + consensusReached — silent
  mafia coordinate only by vote signaling; detective investigationResults
  shape; you.pendingAction for reconnect restore; explicitly NO night
  pending-count for living players — denominator leaks power-role count in
  closed setups). Spec 03 → v2.1 adds env-gated `start_game.seed`
  (ALLOW_TEST_SEED — its own D4 needed it too; production ignores it).
  Spec 04 v2 also pins: scoped @radix-ui/react-dialog (vaul dep — avoid
  double Dialog impls), shadcn source (new-york, CLI-versioned), HoldToPeek
  pointer-capture + iOS callout suppression + AT fallback (timed reveal via
  real button), latest-snapshot-wins interruptible transitions, mechanical
  jq dependency gate, woff2 size recording.
- Specs 01–04 all approved for build. Build order: 01 (in flight) → 02 →
  03 → 04.

## 2026-07-04 — Spec 05 v2 after adversarial review
- Review: 2 BLOCKER / 3 SHOULD-FIX / 4 CONSIDER; all folded, none overruled.
  Spec 02 → v2.3: markAbsent removes players from consensus/pending
  denominators + ONE uniform factional-kill resolution rule on every advance
  path (the stall drill's mechanism now actually exists); `phaseGen`
  double-fire guard on forceAdvance (two host tabs would otherwise skip a
  whole phase); deadlineAt/phaseGen/absent added to ClientGameView. Spec 03
  → v2.2: `force_advance {gen}` + `serverNow` in snapshots (skewed phone
  clocks would make countdowns nonsense). Spec 05 v2: per-phase confirm
  copy (night force-advance ≠ "kill fizzles"), dual-credential identity
  chooser, host-key recovery from localStorage backup, drill tests
  sequenced after the v2.3 pins are built.
- Specs 01–05 all approved. spec01-build still in flight (verified alive,
  files growing).

## 2026-07-04 — Spec 06 v2; full core spec set approved
- spec06-review's final report was lost in transit (2nd occurrence today —
  recovery rule added to CLAUDE.md); recovered via SendMessage resend.
- Review: 2 BLOCKER / 7 SHOULD-FIX / 4 CONSIDER; all folded, none overruled.
  Best catch: the balance caution fired on house defaults for N=3–9 (the
  reviewer computed the table the spec author didn't). Spec 02 → v2.4:
  majority = >half of living players, fixed denominator, failed threshold =
  peace not tie; validateRuleset(ruleset, playerCount) signature pinned,
  declared semantic-only; 5s timer floor. Spec 06 v2: coercePreset named
  mechanism (drift tolerance previously cited a mechanism that didn't
  exist), formal ClientRoomState amendment, set_ruleset excluded from
  lastActivityAt (empty-lobby-immortality), debounce race + per-edit
  broadcast stated tradeoffs, 5s E2E timer, reserved preset name,
  rejection-channel pin, closed-setup retrofit flag.
- ALL core specs (00–06) now review-hardened and approved. Only Spec 07
  (polish) remains unwritten. Still waiting on spec01-build (watchdog
  pinged, no reply yet).
