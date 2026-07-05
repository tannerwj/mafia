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

## 2026-07-04 — Builds: 01 orphaned→resumed; 02 built, verified, fix round
- spec01-build declared orphaned (10 quiet min, typecheck errors on disk) →
  spec01-resume launched in main checkout with WIP inventory brief +
  fresh 20-min watchdog.
- spec02-build (worktree): wrapper went idle after forwarding to Codex, but
  the work landed — caveat: the worktree was based on b8254a2 (origin/
  master), NOT our HEAD, so Codex built the engine inside a pre-scaffold
  checkout (honest notes flagged it). Orchestrator overlaid the engine onto
  a clean HEAD worktree (scratchpad/engine-verify): purity greps clean,
  15/15 tests green, coverage of the hard pins real. Four issues → one fix
  round (spec02-fix, running): game-view layering inversion (shared must
  not import engine), startGame now+roles params (implementer caught a real
  spec gap — Spec 02 → v2.5, committed), kill global registerRoles, widen
  D7 coverage (firstNightKill-off, timer defaults, markAbsent advance,
  order stability).
- Three process rules added to CLAUDE.md (worktree baseline verification,
  wrapper-idle ≠ work-done, lost-report recovery).

## 2026-07-04 — SPEC 01 SHIPPED (fe37a07)
- spec01-resume finished; notes document two platform discoveries:
  getWebSockets() includes just-closed sockets same-turn (liveSockets()
  helper filters), Playwright setOffline doesn't sever established WS
  (init-script socket tracker force-closes). Wake-recovery constructor
  guard present.
- Orchestrator verification ALL GREEN: typecheck · 16 DO tests · 6 E2E
  multi-context flows · build · static greps (no innerHTML, single setAlarm
  site) · LIVE GATE on real Chrome (script in scratchpad): 2-tabs-same-
  browser = distinct seats, killed tab recovers exact seat no duplicate,
  bad host key → error bad_host_key + close 4003, no host-state leak.
  Screenshots sent to Tanner.
- The v0 core complaints (tab-switch death, multi-tab impossible, host
  takeover hole) are now all demonstrably fixed at the foundation layer.
- In flight: spec02-fix (engine fix round in scratchpad worktree).

## 2026-07-04 — SPEC 02 SHIPPED (2d5aa11); Spec 03 building
- Postscript on the "orphan": spec01-build was alive all along — finished,
  report lost/delayed, answered the watchdog ping an hour later. The refire
  was safe because the resume brief mandated inventory-first: spec01-resume
  validated instead of rewrote, added the wake-recovery guard + fixed a
  broadcast-includes-sender race, a test-harness message-loss race, and the
  setOffline E2E gap. Lesson folded into CLAUDE.md rules already.
- spec02-fix (3rd lost report — artifacts told the story): all four fixes
  landed + found a real gate bug (firstNightKill=false never gated the
  mafia consensus path). Engine merged onto master, ALL gates green
  (typecheck, engine 23/23, DO 16/16, build, E2E 6/6, purity greps).
- Known v1.1 limitation (logged, not blocking): applyCommand falls back to
  the default role registry after DO restart — custom-role games need
  registry re-injection when role packs ship.
- spec03-build launched (main checkout, baseline 2d5aa11): DO ⇄ engine
  integration per Spec 03 v2.2. After it: 04 (player UI) → 05 (host
  console) → 06 (ruleset editor), then the live full-game demo.

## 2026-07-04 — Spec 03 built; live gate caught a stranding bug; fix round 1
- spec03-build delivered: 34 DO tests (18 new), .dev.vars for ALLOW_TEST_SEED
  (better than the spec's wrangler.jsonc pin — production compiles to empty
  vars, verified), stale-alarm no-op skips persist+broadcast, RoomMeta.phase
  mirrors engine phase. CI gates ALL GREEN on orchestrator re-run.
- LIVE GATE (raw-WS scripted seed-19 game vs real dev server) caught what
  CI could not: **dawn strands forever** — player-triggered phase
  transitions (last night action, completed vote) pass no `now` to the
  engine, so dawn/dusk beats never arm their setDeadline; D4 tests masked
  it by force-advancing through dawn. Live-gate partial passes before the
  strand: mid-night socket kill + seat-token resume with role intact,
  private investigation delivery, seed-19 role map.
- Fix round 1 sent to spec03-build (thread resumed): now? on all Commands,
  threaded through machine.ts transitions, Date.now() on all DO builders,
  regression tests incl. alarm-driven dawn→day without force_advance.
  Watchdog armed. Dev server left running on :5174 for re-verification.

## 2026-07-04 — SPEC 03 SHIPPED (cb8afac); Spec 04 building
- Fix round 1 verified: engine 24/24, DO 35/35, E2E 6/6, and the live
  raw-WS seed-19 game now runs start→finish with auto-advancing dawn/dusk,
  village win, and rematch retaining all 5 seats.
- Debugging postscript: the live gate's "rematch lost seats" failure was
  the ORCHESTRATOR'S harness bug (next() matched stale pre-game lobby
  snapshots buffered all game — exactly the drain-everything trap the
  builder's notes warned about). Server was correct; decomposed the delta
  until every unit was named (token probe proved storage intact) instead of
  filing a phantom fix round.
- .dev.vars gitignored; CLAUDE.md role table reworded (implementer agents,
  never orchestrator — the builder's fair governance flag).
- spec04-build launched (baseline cb8afac): noir player UI. It will pause
  "READY FOR INSTALL" for the dependency budget (no network in sandbox) —
  orchestrator installs zustand/@radix-ui/react-dialog/vaul/sonner/
  @fontsource-variable/playfair-display then verification proceeds.

## 2026-07-04 — SPEC 04 SHIPPED (ed9c5c2); Spec 05 building
- Player UI took 4 fix rounds, all driven by live/visual gates that unit
  tests structurally could not catch. THE catch: reconnect re-sent the
  original join credential instead of the granted seat token (gameStore
  never called RoomConnection.setAuth) → every mid-game reconnect hit the
  server's 30s auth-reap and cycled forever. This is the v0-killer
  "reconnects break the game" bug, found only by refusing to wave off a
  flaky E2E test. Also fixed: socket-generation guard (stale listeners),
  ConnectionBanner self-retriggering-effect stuck-visible, 600ms-vs-300ms
  phase-fade stuck at 40% opacity. Engine → v2.6 (you.mafiaRoster,
  you.currentVote), both leak-tested.
- Verified: typecheck; engine 26 / client 2 (new project) / server 35;
  playwright 17/17 single-worker clean env. Multi-worker E2E flakes traced
  to alarm-scheduler starvation under machine load (86 zombie chromium +
  70MB bloated .wrangler/state) — env, not code. Config: workers 2,
  per-test timeout 120s.
- New CLAUDE.md process rule: one E2E runner at a time; kill stray
  chromium/vite + wipe .wrangler/state before gate runs.
- spec05-build launched (baseline ed9c5c2): host console, reuses Spec 04
  components; touches no server/engine/reconnect code. Then Spec 06
  (ruleset editor) → live multi-browser demo.

## 2026-07-05 — SPEC 05 SHIPPED; host console verified
- spec05-build delivered D1-D4 green with an honest "no live signal"
  placeholder for the one field it wasn't authorized to add. It also
  fixed a latent bug unprompted: serverNow was parsed off the wire and
  DISCARDED — countdowns had no clock-offset correction until now; added
  clockOffsetMs + serverNow(). Upgraded host-key recovery from silent
  auto-connect to an explicit "Resume as host" offer + dual-cred chooser.
- Engine → v2.7: players[].acted (host-only, night-only, actors-only)
  landed by a focused agent; leak-tested. The host night-status column
  ("0 of N have acted — waiting on M", PENDING for actors, ASLEEP for
  non-actors) is now live.
- Verified: typecheck clean; engine 27 / client 4 / server 35; E2E
  near-green (host-console suite 24 tests); LIVE host-console tour
  screenshots confirm god-view table w/ alignment-tinted roles, acted
  column, House-rules card, controls, log, privacy chip.
- Ongoing env pain (documented): this box is overloaded — persistent
  Monitor tool + background waits die exit 144, E2E flakes on dev-server
  health under load. Code correctness confirmed via unit/integration
  green + live tour; E2E flake is environmental, not a defect (same as
  Spec 04). Kill zombies + wipe .wrangler/state + workers=1 for clean E2E.
- Remaining: Spec 06 (ruleset editor) → live multi-browser demo. Then done.
