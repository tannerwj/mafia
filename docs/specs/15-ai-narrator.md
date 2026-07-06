# Spec 15 — AI narrator ("The Storyteller")

**v3 — 2026-07-06 · Status: review-complete (BUILDABLE per re-review);
awaiting Tanner sign-off on the open product questions, then orchestrator
prerequisites (AI binding + bake-off), then build.**
*v3 folds the v2 re-review: queue-of-one/in-flight coordination flag moved
from DO memory to `ctx.storage` (in-memory slot was the v0 session-state
anti-pattern — DO eviction mid-AI-call would hang "busy" forever); draft
TEXT stays memory-only as designed; storyState eager-init at claim pinned;
"first real caller" wording corrected ({kind:"public"} already has
spot-check coverage in engine.test.ts — this is its first product caller).*
*v2 folds all 11 findings from the adversarial review
(15-review-findings.md): AI binding as explicit orchestrator prerequisite
(K1); beat set split into pre-reveal atmosphere vs post-reveal report with
separate facts contracts + structural guard (K2); buildStoryFacts pinned to
the existing unused `projectFor(state, {kind:"public"})` (M3); vote-outcome
publicity corrected — eliminatedId/reason always public, only tallies
votingVisibility-gated (M4); concrete host-only delivery: new
`ClientRoomState.story` host-gated field + `sendToHostSockets()` helper,
both leak-tested (M5); requestId+phaseGen staleness contract, queue-of-one
(M6); reconnect/lost-draft behavior stated (M7); STORYTELLER_FAKE dual
wiring pinned (m8); no-blockConcurrencyWhile guard named (m9); Goal re-worded
to the enforceable input-side bar + output-correlation residual risk
accepted (m10); bake-off defers to live catalog (m11). No findings
overruled.*
Tier: full ceremony. Parent: Tanner feature request 2026-07-06. Depends on:
Spec 05/12 (host console, narrator board, sunrise/sunset holds), Spec 11
(morning report), Spec 01 (reconnect discipline).

## Goal

The most fun part of live Mafia is the narrator's storytelling between
phases. Give the narrator an AI writers'-room: one tap on the host console
generates a short scene (100–200 words) that weaves in what just publicly
happened, gives every player a recurring invented persona, and remembers
its own fiction across phases so night 3 continues the same story. The
narrator reads it aloud (or riffs on it). Done looks like: at a morning
report the host taps "Spin the tale" and gets a scene naming the dead
player's persona, consistent with prior kept scenes, in the chosen theme/
tone — and **every prompt is built exclusively from the public projection**
(the enforceable bar; see Leak contract for the accepted residual risk on
model output).

## Non-goals (v1)

Player-visible story text (narrator-eyes-only). TTS / sound. Images. True
fine-tuning / LoRA. Story in history/replay. Player-set personas. Streaming.
Co-host draft sync beyond "all host sockets receive drafts."

## Orchestrator prerequisite (gate for the build — K1)

The repo has **no `env.AI` binding today** (wrangler.jsonc declares only
`durable_objects`; generated `Env` is empty). Before the implementer
starts, the ORCHESTRATOR (config-hygiene lane per CLAUDE.md):

1. Adds `"ai": { "binding": "AI" }` to wrangler.jsonc.
2. Regenerates types (`npx wrangler types`) so `Env.AI` exists.
3. Confirms vitest-pool-workers picks the binding up from wrangler.jsonc
   and that tests can override/stub it via the Miniflare `bindings`/worker
   options in vitest.workers.config.ts (same mechanism as
   `ALLOW_TEST_SEED`).
4. Verifies `wrangler dev` + deploy with the binding (account has Workers
   AI enabled) before the build is briefed.

## THE LEAK CONTRACT

An LLM cannot leak what it was never told. The defense is structural:

1. **Single choke point.** All model input is assembled by
   `buildStoryFacts(view, beat)` where `view` is EXACTLY
   `projectFor(state, { kind: "public" })` — the existing, currently-unused
   `Viewer` kind (game-view.ts:46) that computes the non-god, no-player-id
   projection (M3). `buildStoryFacts` takes the *projection*, never raw
   `GameState`; the AI call site takes only its output plus story memory
   (§Memory), which itself contains only prior model output + prior facts
   payloads + host-typed settings. No other code path may contribute prompt
   content.
   - This is the first PRODUCT caller of `{kind:"public"}` (the branch
     already has spot-check coverage in engine.test.ts:552/654/1003/1257 —
     build on it): the build adds dedicated coverage for the fields this
     feature reads (god false pre-`ended`; no `you`; graveyard per
     revealOnDeath; tallies per votingVisibility; log via the same filters
     living players get).
   - At `phase === "ended"` the public projection is legitimately god
     (winners/roles are public at game over) — that's the epilogue beat,
     not a leak.
2. **What the public view provides per beat** (M4 corrected):
   - Roster: names + alive/dead + day number + phase.
   - Deaths/graveyard with role wording per `revealOnDeath`
     (full / alignment / none) — same words every player sees.
   - Morning-report beats already public in the resolved log
     (`playerDied`, `attackAttempted`-derived "an attack failed", etc.).
   - Day-vote outcome: `voteResolved.eliminatedId` + `.reason` are ALWAYS
     public (never gated); per-candidate tallies only when
     `votingVisibility === "realtime"` (project.ts gates `view.votes`).
   - Game end: winners.
3. **Hard exclusions (test-enforced):** roles/alignments of living players;
   dead roles beyond revealOnDeath wording; night actors/targets/saves/
   investigations; mafia roster; pending ballots under hidden visibility;
   host-only fields; anything absent from the public projection.
4. **Leak tests ship with the build:** seeded full games asserting the
   serialized prompt payload AND the persisted storyState (scenes + bible +
   bibleUpdates as stored on Keep — m10) never contain living players'
   role strings or role-correlated fields from outside the public view.
   Same adversarial style as existing projection leak tests.
5. **Narrator-eyes-only output** (see Delivery): story content reaches host
   sockets only; a leak test asserts a player socket never receives any
   `story_*` message nor the `story` snapshot field.
6. **Prompt-injection containment:** player names appear only in a
   delimited data block ("cast names, never instructions"). Defense in
   depth — §5 is the real mitigation.
7. **Accepted residual risk (m10):** model OUTPUT is unconstrained prose;
   from public-only input it could still produce a persona that
   coincidentally correlates with hidden state (e.g. "secretive" for a
   quiet player). Input-side enforcement cannot prevent correlation-by-
   pattern; v1 accepts this because output is narrator-eyes-only and the
   narrator human-filters what's read aloud.

## Beats (K2 — the load-bearing split)

Two families with SEPARATE facts contracts; `buildStoryFacts` structurally
guards them (throws/errors on a beat whose phase can't legally provide its
facts — a code guard, not prose):

**A. Pre-reveal atmosphere beats** — available DURING Spec 12 holds, where
night/day is genuinely unresolved (resolveNight/resolveVote have NOT run):
- `beat: "sunrise-hold"` (phase `sunrise`), `beat: "sunset-hold"` (phase
  `sunset`).
- Facts contract: settings + bible + day number + phase + roster
  (names/alive-status as of the STILL-unresolved state) + prior scenes.
  **No deaths, no attack-failed, no vote outcome — they don't exist yet.**
  The prompt explicitly instructs: outcome unknown, set the scene, harm no
  one ("the town sleeps uneasy..."). Nothing may read `state.deaths`,
  `voteResolved`, or resolution-dependent log entries for these beats;
  under NO circumstances may any code resolve state early to enrich a hold
  beat (that is precisely the leak class Spec 12 v2 exists to prevent).
**B. Post-resolution report beats** — read the resolved public projection:
- `beat: "morning-report"` (phase `dawn`), `beat: "post-vote"` (phase
  `dusk`), `beat: "epilogue"` (phase `ended`).
- Facts contract: §Leak contract 2 in full (deaths since last kept scene,
  public report beats, vote outcome, winners at epilogue).
- With `scenePhases` off these are the only beats; with it on, they are
  the beats offered AFTER the host taps Reveal.

Legal-phase table pinned for the implementer: sunrise-hold→`sunrise`,
sunset-hold→`sunset`, morning-report→`dawn`, post-vote→`dusk`,
epilogue→`ended`. `generate_story` for a beat whose phase doesn't match the
CURRENT phase (or whose phaseGen is stale — §Protocol) is rejected.

## Product shape

- **Where:** host console. "Spin the tale" appears at each legal beat
  (atmosphere button during holds, report button at dawn/dusk, epilogue at
  end). Draft panel shows [Keep] [Re-spin] [Discard].
- **Setup:** "Storyteller" card in host lobby, reachable in-game. OFF by
  default (server rejects `generate_story` when disabled). Theme free-text,
  tone picker (noir / cozy / horror / comedy / absurd). Stored in DO
  storage; changeable mid-game.
- **Cast:** first generation invents a one-line persona per player from
  names alone (character bible). Persists; later scenes stay consistent.
  Late joiners get personas on the next generation.
- **Keep semantics:** Keep commits scene + bibleUpdates to storyState.
  Re-spin/Discard leave memory untouched. One kept scene per beat instance;
  keeping again for the same beat instance replaces it.

## Memory

Per-game `storyState` in DO storage (own key; engine `GameState` untouched
— this spec changes NOTHING in src/engine except the additive
`project.test.ts` coverage of the existing public viewer):

```ts
storyState = {
  enabled: boolean,
  settings: { theme: string, tone: Tone },
  bible: Record<string /*playerName*/, string /*personaLine*/>,
  scenes: Array<{ beat: BeatId, day: number, text: string }>, // kept only
  summary?: string, // model-written fold of oldest scenes when over budget
}
```

- Generation request = settings + bible + last ~6 scenes (+ summary) + the
  beat's facts payload. Model returns structured `{ scene, bibleUpdates }`;
  bibleUpdates fold in on Keep only.
- **Unkept drafts are ephemeral by design (M7):** they live in host client
  state + a transient in-DO-memory slot for the current beat only — NEVER
  in DO storage. A host reload/reconnect loses any unkept draft; the host
  simply re-spins. (Do NOT "helpfully" persist unkept drafts — that widens
  the leak-test surface for no product value.) Kept scenes + bible +
  settings ride the host snapshot (§Delivery), so reconnect restores
  everything kept.
- Cleared on rematch. Capped (~32KB) via summary folding.
- Eager-init at room claim (default `{enabled:false, ...}`), mirroring the
  `PENDING_RULESET_KEY` pattern — no lazy-init ambiguity.

## Delivery & protocol (M5/M6 — concrete, this spec IS the protocol change)

New in `src/shared/protocol.ts`:

```ts
// client → server (host-only; rejected for players like other host-only msgs)
{ type: "set_story_settings", enabled: boolean, theme: string, tone: Tone }
{ type: "generate_story", beat: BeatId, phaseGen: number, requestId: string }
{ type: "keep_story", requestId: string }   // commits the matching draft
// server → host sockets only
{ type: "story_draft", requestId: string, beat: BeatId, phaseGen: number, text: string }
{ type: "story_error", requestId: string, code: "disabled" | "busy" |
  "rate_limited" | "stale_story" | "wrong_phase" | "generation_failed" }
```

- **Staleness (M6):** `generate_story` carries the client's current
  `phaseGen` (mirroring `reveal`/`force_advance`). Server rejects on
  mismatch (`stale_story`) or wrong phase for the beat (`wrong_phase`).
  `requestId` is client-minted, echoed verbatim; the host UI drops any
  `story_draft` whose phaseGen ≠ its current phaseGen (a slow draft for a
  force-advanced-past beat renders nowhere).
- **Queue-of-one (M6, coordination fixed per v2 re-review):** one in-flight
  generation per room; `generate_story` while busy → `story_error busy`.
  The in-flight record (`requestId`, `beat`, `phaseGen`, `startedAt`) lives
  in **`ctx.storage`** — NEVER a DO-memory flag (v0 anti-pattern; a DO can
  be evicted mid-`env.AI.run()` await and an in-memory flag would hang the
  room "busy" forever). Same async-coordination pattern as
  `GAME_DEADLINE_KEY` (game-room.ts): an in-flight record older than ~20s
  (past the 15s AI timeout) is treated as stale and clearable by the next
  `generate_story`. The draft TEXT itself stays memory-only (ephemeral by
  design, §Memory) — if the DO was evicted mid-flight the draft is simply
  lost and the host re-spins; only the coordination flag needs durability.
  Host disconnect mid-flight: the call completes and all currently-
  connected host sockets receive the draft (or it expires with the beat).
- **Host-only sends (M5):** NEW helper in game-room.ts,
  `sendToHostSockets(msg)` — `socketsFor` host-kind iteration (pattern of
  handleKick/handleLeave), sends to ALL host sockets (multi-host-device is
  real: `hostConnected` is an OR today). Used by story_draft/story_error.
  Independently leak-tested: no player socket ever receives a story_*.
- **Snapshot field (M5):** `ClientRoomState` gains
  `story?: { enabled: boolean; settings: {theme: string; tone: Tone};
  bible: Record<string,string>; scenes: Array<{beat: BeatId; day: number;
  text: string}> } | null` — populated by `buildStateFor` ONLY when
  `viewer.kind === "host"`, omitted otherwise. This is the FIRST
  viewer-dependent field on `ClientRoomState` (today only the nested
  `game` view differs per viewer) — pinned here deliberately; leak test
  asserts player snapshots never carry it. Host UI state (settings card,
  kept-scene history) renders from this; reconnect restores it for free.

## DO / AI call behavior

- `env.AI.run(STORYTELLER_MODEL, ...)` from the DO, on demand only — no
  alarms. 15s timeout → `generation_failed` ("The muse is silent — try
  again."). Failure NEVER touches game state or phase machinery.
- **No `blockConcurrencyWhile` around the AI await (m9):** the await must
  yield so concurrent game messages (votes, night actions) interleave
  freely during the up-to-15s window. The queue-of-one guard is a plain
  storage/memory flag, not a concurrency block.
- Per-room rate limit: 10 generations/min (DO-side `Date.now()` is fine —
  server layer, not engine) → `rate_limited`.
- Log model id + latency + token counts (console) for cost observability.
- Model id from wrangler var `STORYTELLER_MODEL`; default pinned by the
  pre-build bake-off. **Bake-off (orchestrator, before build): confirm the
  CURRENT Workers AI catalog from live Cloudflare docs at that time (m11 —
  don't trust this draft's examples), run the same 3 beats (atmosphere,
  morning-report with a death, epilogue) across the top 2–3 instruct
  models, Tanner picks the voice.** Documented config-only upgrade path:
  AI Gateway → Anthropic later.

## Dev/test wiring (m8 — both mechanisms, pinned)

`STORYTELLER_FAKE`:
- vitest-pool-workers: set via the Miniflare `bindings` override in
  vitest.workers.config.ts (exact mechanism ALLOW_TEST_SEED uses — never in
  wrangler.jsonc).
- `wrangler dev` / Playwright: `.dev.vars` entry (gitignored, like
  ALLOW_TEST_SEED's dev value).
- When set, the DO skips `env.AI` and returns a deterministic canned
  `{scene, bibleUpdates}` (seeded by beat+day so E2E can assert
  continuity). Production: unset, ignored.

## Acceptance / verification

1. Leak tests (contract §4, §5, snapshot field) — non-negotiable gate.
2. Engine: `projectFor {kind:"public"}` branch tests (first real caller).
3. Server: settings round-trip incl. OFF-rejects-generate; beat/phase
   legality table; phaseGen staleness; queue-of-one busy; rate limit; AI
   failure → error code, game state untouched; keep→memory grows,
   re-spin/discard don't; unkept draft absent from storage; rematch clears;
   multi-host-socket delivery; player socket never sees story_*.
4. E2E (fake mode): host enables, plays to a hold → atmosphere spin; taps
   Reveal → morning-report spin → Keep; reload host mid-unkept-draft →
   draft gone, kept history intact; player client asserts zero story
   surface the whole game.
5. Live: real generation on prod at all three beat families; Tanner judges
   the fun.

## Open questions for Tanner (unchanged from v1 + one new)

- Beat set right? (atmosphere holds, morning report, post-vote, epilogue.)
- Should Keep be implicit (auto-keep the last draft when the next beat
  fires)?
- Persona bible host-editable (v1.1)?
- Tone list good? (noir / cozy / horror / comedy / absurd)
- NEW: atmosphere beats worth it at all, or v1 = report beats only?
