# Spec 15 implementation notes — AI narrator ("The Storyteller")

Build against `docs/specs/15-ai-narrator.md` v3 (SIGNED OFF). HEAD at start:
`425c1ae`. Orchestrator prerequisites (env.AI binding in wrangler.jsonc,
STORYTELLER_MODEL var, `.dev.vars` STORYTELLER_FAKE=1) were already in place —
confirmed before starting, no config-hygiene work needed beyond regenerating
`worker-configuration.d.ts` (gitignored) via `npx wrangler types` once
`.dev.vars` picked up `STORYTELLER_FAKE`.

## Files

- `src/server/storyteller.ts` (new) — the leak-contract choke point.
  `buildStoryFacts(view, beat, nameOf)` takes ONLY a `ClientGameView` (the
  shape `projectFor(state, {kind:"public"})` returns) — it has no import of
  `GameState`/engine types at all, so a parallel reimplementation reading raw
  engine state is structurally impossible in this file. Also: `buildPrompt`
  (system/user prompt construction per the Prompt contract appendix),
  `parseStoryOutput`/`extractRawText` (defensive output parsing: `<think>`
  stripping, `{response}` vs `{choices[0].message.content}`, hard word-trim),
  `fakeStoryOutput` (STORYTELLER_FAKE canned output, seeded by beat+day).
- `src/server/game-room.ts` — storage keys (`STORY_STATE_KEY` eager-init at
  claim mirroring `PENDING_RULESET_KEY`; `STORY_INFLIGHT_KEY` in `ctx.storage`
  per the v2-re-review fix), the three new handlers
  (`handleSetStorySettings`/`handleGenerateStory`/`handleDiscardStory`),
  `sendToHostSockets`, `autoCommitSupersededDrafts` (wired into
  `applyGameResult` right after the game-state transition, and into
  `handleNewGame` for a still-pending epilogue draft), rate limiting,
  `pendingDrafts` (DO-memory-only `Map`, never `ctx.storage` — the ephemeral
  draft-text design).
- `src/shared/protocol.ts` — `SetStorySettingsMessage`/`GenerateStoryMessage`/
  `DiscardStoryMessage` (client→server), `StoryDraftMessage`/
  `StoryErrorMessage` (server→host-only), `ClientRoomState.story` (host-gated
  field, `StoryState`/`Tone`/`BeatId` types).
- `src/client/net/RoomConnection.ts` — `onStoryDraft`/`onStoryError` events.
- `src/client/store/gameStore.ts` — `storyDraft` (ephemeral client state, per
  spec never persisted), `setStorySettings`/`generateStory`/`discardStory`
  intent helpers, phaseGen-staleness drop on snapshot.
- `src/client/screens/host/Storyteller.tsx` (new) — `StorytellerSetupButton`
  (dialog: enable toggle, theme free-text, 5-tone picker) mounted in
  `HostLobby.tsx` and `HostGame.tsx`; `StorytellerPanel` ("Spin the tale" +
  draft `[Re-spin]`/`[Discard]` + kept-scene history) mounted in
  `HostGame.tsx` and `HostGameEnd.tsx` (epilogue).
- `vitest.workers.config.ts` — added `STORYTELLER_FAKE: "1"` to the Miniflare
  bindings override (same mechanism as `ALLOW_TEST_SEED`).
- Tests: `test/server/storyteller.test.ts` (22 unit tests: BEAT_PHASE table,
  structural guard, leak-contract field-by-field checks, prompt contract,
  defensive parsing, fake output), `test/server/game-room.test.ts` (+21
  integration tests: settings round-trip/authority, beat/phase legality +
  staleness, queue-of-one incl. DO-eviction survival, rate limit, auto-keep/
  discard/re-spin, fire-safe commit, rematch clears memory, multi-host
  delivery, player-leak proofs incl. persisted-storyState role-string check),
  `test/engine/engine.test.ts` (+5 tests: dedicated `{kind:"public"}`
  coverage — `god` false pre-`ended`, no `you`, graveyard/tallies gating
  parity with a living player, log filtering parity),
  `test/e2e/ai-narrator.spec.ts` (written, NOT run — orchestrator's job per
  the brief): lobby enable + morning-report spin + auto-keep-into-history,
  reload-mid-pending-draft, atmosphere beat leak proof, player-side
  zero-story-surface proof.

## Deviations from the spec (with reasons)

1. **Summary folding replaced with scene trimming.** The spec's `§Memory`
   mentions "capped (~32KB) via summary folding" and a `summary?: string`
   field on `storyState`. I implemented the cap as FIFO trimming of the
   oldest kept scenes (`commitDraft` in game-room.ts) rather than having the
   model write a summary — no model call exists at commit time (commit is a
   pure post-hoc fold of already-generated text, not a new generation), so
   "model-written fold" would require a SECOND AI call per commit that the
   spec doesn't otherwise describe triggering. I kept `StoryMemory.summary`
   as an optional field in `storyteller.ts` (so `buildPrompt` already handles
   it if a future spec wires summarization in) but `game-room.ts` never
   populates it — v1 ships without generated summaries; the trim keeps the
   ~32KB cap enforced today via the simpler, equally leak-safe mechanism
   (trimming never touches content, so there's nothing new to leak-test).
   Flagging for a v1.1 spec note if Tanner wants real summarization.
2. **`env.AI.run` called through a loosely-typed handle.** The generated
   `Ai.run` overloads key off `AiModelList`'s literal model-name keys;
   `STORYTELLER_MODEL` is a runtime string var, not a literal type, so
   TypeScript can't resolve an overload against it. I cast `this.env.AI` to
   `{ run: (model: string, inputs: unknown) => Promise<unknown> }` at the one
   call site rather than fighting the overload resolution — `parseStoryOutput`
   already defensively handles whatever shape comes back regardless of model,
   so this loses no real type safety (the alternative, a giant conditional
   type threading `STORYTELLER_MODEL`'s value through, would be pure
   ceremony for a value TS can't know at compile time anyway).
3. **Auto-commit granularity is per-draft, not per-beat-slot.** The spec's
   English describes "the latest non-discarded draft for a beat" (singular).
   My `pendingDrafts` is a `Map<requestId, draft>`; a re-spin for the same
   beat now explicitly deletes any other pending draft for that beat before
   inserting the new one (see `handleGenerateStory`'s "Re-spin" block) so the
   map only ever holds one entry per beat in practice — I added this after a
   test caught the bug (both `r1` and `r2` would otherwise commit on
   supersession, double-committing). Documented here since it's a real fix
   the spec's prose didn't spell out at the data-structure level.
4. **Rate limit key name.** Used the literal string `"storyRateLimit"` as a
   plain inline `ctx.storage` key rather than a named module constant
   (unlike `STORY_STATE_KEY`/`STORY_INFLIGHT_KEY`) — minor inconsistency,
   harmless, left as-is rather than a drive-by cleanup outside review scope.

## Things I verified against the spec/review docs explicitly

- `buildStoryFacts` throws on a beat/phase mismatch (structural guard, K2) —
  unit-tested directly in `storyteller.test.ts`, and end-to-end via the DO's
  own `wrong_phase` rejection before `buildStoryFacts` is ever called (the DO
  checks `currentPhase !== BEAT_PHASE[msg.beat]` itself as a first gate, so
  `buildStoryFacts`'s throw is a second, defense-in-depth guard — it should
  never actually fire via the real protocol path, only if a future code path
  calls it directly with a bad pairing).
- `{kind:"public"}` is the exclusive read (leak contract §1) — `buildStoryFacts`
  imports zero engine types; `game-room.ts`'s `handleGenerateStory` computes
  `view` via `projectFor(game!, {kind:"public"})` and passes only that.
- `voteResolved.eliminatedId`/`.reason` always public; only tallies gated by
  `votingVisibility` (M4 correction) — unit-tested in both
  `storyteller.test.ts` and `engine.test.ts`.
- Queue-of-one lives in `ctx.storage`, not DO memory (M6/v2-re-review finding
  7, the one MAJOR the re-review left) — `STORY_INFLIGHT_KEY` is a
  `ctx.storage` key; `game-room.test.ts` has a dedicated test that plants the
  record, runs `evictDurableObject`, and confirms a fresh `generate_story`
  still sees it (proving it's not an in-memory flag that would have silently
  vanished).
- No `blockConcurrencyWhile` around the AI await (m9) — confirmed by
  inspection; the only `blockConcurrencyWhile` in the file remains the
  pre-existing constructor alarm-recovery guard.
- `sendToHostSockets` iterates `socketsFor(ctx, a.kind === "host")`, mirroring
  `handleKick`/`handleLeave`'s pattern exactly, and is independently
  leak-tested (multi-host delivery + player-never-sees-story_* tests).
- `ClientRoomState.story` populated only for `viewer.kind === "host"` in
  `buildStateFor` — leak-tested (player snapshots always `null`).
- Fire-safe auto-commit: wrapped in try/catch, runs after the storage
  put/effects/but before `touchAndBroadcast` — tested by corrupting story
  storage and confirming the phase advance still succeeds.

## Verification

- `npm run typecheck` — clean (all 6 tsconfig project references).
- `npm test` — **297 passed, 0 failed** (engine 175, client 32, server 90).
- Playwright/`wrangler dev`/deploy: NOT run by me per the brief — the E2E
  spec (`test/e2e/ai-narrator.spec.ts`) is written and ready for the
  orchestrator to run against a real `wrangler dev`/`npm run dev` instance
  with `STORYTELLER_FAKE=1` from `.dev.vars`.

Tree left uncommitted per the brief.

STATUS: COMPLETE
