# CLAUDE.md — Mafia rebuild operating rules

Read `docs/PLAN.md` (architecture + decisions) and `STATUS.md` (current state)
before doing anything. The process is `docs/ORCHESTRATION-PLAYBOOK.md`.

## Roles

| Role | Who |
|---|---|
| Architecture, specs, plans, docs | Orchestrator (lead Claude session) |
| Adversarial spec review | A different set of eyes than the spec author (Codex runtime or a fresh subagent) |
| Writing all application code (`src/`, `test/`) | Implementer agents (Codex runtime or Claude subagents) — **never the orchestrator**. Assume no network: orchestrator runs installs/live steps |
| Research (web, docs, live probes) | Claude subagents |
| Live steps: installs, wrangler dev/deploy, verification, commits | Orchestrator only |

Exceptions — orchestrator may edit directly: docs, specs, STATUS.md, config
hygiene (.gitignore, tsconfig, wrangler.toml tweaks), and the **Spec 00
scaffold** (generator-driven, needs network). Never application logic.

## Hard rules

- v0 is retired; it lives in git history (≤ `b8254a2`). Don't resurrect
  patterns from it — especially: identity from connection/session IDs,
  "no active host → anyone authorized" fallbacks, game state in localStorage,
  in-memory session Maps, `setInterval` in the DO.
- Server is authoritative. Clients render snapshots; secrets (roles, private
  knowledge) only ever flow through the engine's visibility projection.
- Never interpolate player-provided strings into HTML (v0 had name-based XSS).
  React escaping is the default; no `dangerouslySetInnerHTML`.
- Engine (`src/engine/`) stays pure TS: no Cloudflare imports, no I/O, no
  `Date.now()`/`Math.random()` — clock and RNG are injected.
- `src/shared/protocol.ts` is the single source of truth for messages; client
  and server both import it. Change it only via a spec.
- Every spec's build lands with its tests; implementers record deviations in
  `docs/specs/NN-implementation-notes.md`, never edit specs.
- Git: branch `master`, no Co-Authored-By lines, commit only after
  orchestrator-run verification passes.

## Verification gates (per spec)

1. `npm test` (engine + pool-workers) — fresh run by orchestrator.
2. Playwright E2E — multi-context game flows.
3. Live: `wrangler dev`, multiple tabs of one browser (must work — that's a
   product requirement, not just a test convenience).

## Process rules learned

(grow this — every surprise becomes a rule, same day)
- 2026-07-04: Session/connection identity ≠ player identity. Any auth model
  that breaks when a socket drops is wrong by construction.
- 2026-07-04: An agent's idle notification without its final report means
  the report was lost in transit, not that no work happened (twice today:
  scaffolder, spec06-review). Recover: check artifacts on disk first, then
  SendMessage the agent to resend. Never re-run the work blind.
- 2026-07-04: Watchdog quiet-threshold works: spec01-build went 23 min
  file-quiet → pinged for status instead of waiting. Keep ~15-20 min as the
  investigate trigger for build agents.
- 2026-07-04: Adversarial reviews keep finding the same killer class on
  stacked specs: UI/downstream specs assuming projection/protocol fields no
  upstream spec pinned. Every future spec review brief must include "walk
  every data element against what upstream specs ACTUALLY provide."
- 2026-07-04: Agent worktree isolation based the worktree on origin/master
  (b8254a2), NOT the local HEAD with our commits — the engine got built in a
  pre-scaffold checkout. Rule: every worktree brief starts with "run
  `git log --oneline -1` and STOP if it isn't <expected sha>"; orchestrator
  verifies deliverables by overlaying them onto a known-good worktree.
- 2026-07-04: codex-rescue wrapper agents forward to the shared runtime and
  then go idle with "I'll let you know" — the notification you get is the
  wrapper stopping, not the work finishing. Judge completion by artifacts on
  disk (files + implementation notes), never by wrapper chatter.
- 2026-07-04: Playwright runs collide on the shared :5173 dev server
  (strictPort + reuseExistingServer): orchestrator and implementer running
  the suite concurrently produce phantom flakes and nonsense test counts.
  Rule: one runner at a time — coordinate via the notes-file STATUS marker;
  kill stray vite/headless-chromium processes before every E2E run and
  after every tour.
