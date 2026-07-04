# The Orchestrator Playbook
*How to run a software project where the lead agent never writes code.*

Project-agnostic — drop into any repo and adapt. Written for an agent (Claude) acting as orchestrator, with Codex + Claude subagents (Opus/Sonnet) as the workforce.

---

## 1. The model

One **orchestrator** owns the project end-to-end and never touches application code. It plays: architect, spec author, adversarial-review runner, delegator, live verifier, release manager, and historian. Everything else is delegated with explicit contracts.

| Role | Who | Why |
|---|---|---|
| Architecture, specs, plans | Orchestrator | Judgment + context live here |
| Adversarial spec review | A *different* model (Codex) | Fresh eyes; different failure taste |
| Writing all code | Codex | Great implementer against exact contracts; its sandbox has **no network** — treat it as coding blind |
| Research / reality-gathering (APIs, docs, live probes) | Claude subagents (pin model: opus/sonnet/haiku) or orchestrator | They have network + environment |
| Live steps: credentials, deploys, real-API calls, verification | Orchestrator ONLY | One owner for secrets, lockout budgets, and irreversible actions |
| Commits | Orchestrator, only after independent verification | The verifier signs the release |

Exceptions where the orchestrator edits files directly: docs, specs,
config/hygiene (.gitignore, CLAUDE.md, STATUS.md), data-entry YAML. Never
`src/`. This rule feels slow exactly once per day and pays for itself
daily — every "2-line fix" the implementer makes lands with a regression
test you'd have skipped.

## 2. The core loop (per piece of work)

```
1 SPEC      orchestrator writes docs/specs/NN-<piece>.md
2 REVIEW    adversarial review by another model → fold findings → vN+1
3 BUILD     handoff to Codex with the spec as contract
4 VERIFY    orchestrator independently re-runs everything + live checks
5 FIX LOOP  failures → one evidence-backed fix per round → re-verify
6 CLOSE     commit, update STATUS.md, update the task board
```

Pipeline aggressively: while one piece builds, write and review the next
two specs in parallel (reviews are read-only — they never conflict with a
build). Builds in the same worktree run **sequentially** (shared files like
CLI entry points and lockfiles collide).

## 3. Writing specs that survive contact with an implementer

A spec is a contract, not a vision statement. Sections that earn their keep:

- **Goal** — one paragraph, ends with what "done" looks like observably.
- **Non-goals** — explicit. Prevents scope creep AND accidental ambition.
- **Pinned conventions** — anything two reasonable implementations would do
  differently gets pinned (rounding rules, ordering semantics, sign
  conventions, timezone, exit codes, error precedence). If a golden test
  must pass "to the cent," every convention it depends on must be written.
- **Deliverables** — numbered, each independently checkable.
- **Acceptance criteria** — split **CI-verifiable** (fresh clone, no
  secrets, synthetic data) from **live verification** (orchestrator-run,
  real systems). Every criterion must be falsifiable — "works correctly"
  and "output is sane" are not criteria; "exit 1 on X, tested" is.
- **Notes for implementer** — dependency budget, style constraints, where
  to record deviations (`NN-implementation-notes.md` — implementers never
  edit specs; that file is theirs, the spec is yours).

## 4. Adversarial review (the highest-value practice)

Before any build: hand the spec to a different model with instructions to
attack it. Demand structure: **BLOCKER / SHOULD-FIX / CONSIDER**, each with
a section reference, one-line rationale, and a *concrete* resolution.

What makes reviews good:
- Point the reviewer at the sharp edges you already suspect ("check the
  ordering semantics," "is this atomicity claim achievable on this
  platform?") — you'll still get surprises, but you guarantee coverage of
  the known risks.
- **Ground the review in real artifacts** when they exist: the installed
  library in node_modules, the live database, the actual input document.
  A reviewer that crash-tests a component in renderToString beats one that
  reasons from documentation.
- Fold in everything defensible; where you overrule a finding, say so in
  the spec ("kept X against review advice because …").

Expect the review to catch silent-corruption classes the spec author is
structurally blind to (in this project: three separate "stale data wins the
ordering" bugs, an atomicity claim the platform couldn't honor, thresholds
that would false-alarm on real data).

## 5. Delegation briefs

Every handoff includes:
- Exact file paths to read first (spec, prior implementation notes, rules
  doc), and the baseline state ("commit X, suite green").
- **Reality, embedded**: never let a coder guess an external interface.
  Before briefing: probe the real API/library and paste ground truth —
  installed `.d.ts` signatures, a field census of live responses (every
  field → observed types/nullability), verified endpoints. The most
  expensive failure mode in this whole methodology is a blind implementer
  inventing a plausible-but-fictional interface.
- Constraints, verbatim, every time: run nothing you can't run (Codex has
  no network — the orchestrator runs installs/tests/live steps), don't
  commit, don't touch specs, record deviations in your notes file, report
  before going idle.
- What to report back: results, decisions, deviations, and what the
  orchestrator must run next (exact commands).

Fix rounds are the same but smaller: **one fix per round, with the exact
error output pasted**, plus the required regression test. Resume the same
implementer thread when the fix is follow-up to its own code (context
survives); go fresh for new components.

## 6. Verification: trust nothing, re-run everything

- Re-run the full suite yourself even when the implementer reports green —
  its environment differs (and it may not have been able to run anything).
- **Live verification is a distinct phase** from CI, and it catches what
  synthetic tests structurally cannot: schema drift, environment quirks,
  stale-vs-fresh database divergence, platform limits, tool output
  formats. Budget for a live fix loop on every externally-facing piece —
  4-6 rounds is normal for a first connector, and each round should
  *harden the system*, not just patch the symptom.
- **Reconcile against an independent source of truth** when one exists
  (an aggregator's own totals, a vendor's reported counts). Decompose any
  delta until every unit is named — "close enough" hides sign errors.
- Design fail-safes so failed runs can't corrupt: candidate→validated
  promotion for data writes, pointer-flip activation for replicas,
  fail-closed for anything cryptographic. Then verify the fail-safes fire.

## 7. Running long work: watchdogs, not patience

Background agents and long tasks fail silently. Standing rules:

- **State an ETA for every launch**; arm a watchdog at ~2× ETA.
- The watchdog distinguishes three states: **finished** (proceed),
  **dead process** (pid gone — cancel + refire with resumed context),
  **quiet-but-alive** (long generation turn — tolerate ~15 min before
  investigating). Heartbeat-stale + pid-dead = orphan, always.
- Watchdogs emit an "armed" event immediately — a monitor that can't speak
  is indistinguishable from nothing to watch. (Ours failed silently twice
  from a shell quoting quirk before this rule.)
- Wrapper/forwarder agents are unreliable at long-horizon duties: they go
  idle without reporting, misread roles, and "wait" without waiting. Use
  them only for large self-contained offline builds; keep tight iteration
  loops and all monitoring in the orchestrator's own session.
- CLI/process hygiene bugs (a tool that never exits, a spinner polluting
  JSON stdout) *look identical to* "still working." When something seems
  slow: check the evidence (pid, log mtime, output bytes) before waiting
  longer.

## 8. Memory across sessions

The orchestrator's context dies; the project must not.

- **CLAUDE.md** — the operating rules (roles, hard constraints, process
  lessons). When the human corrects the process or a failure teaches a
  rule, bake it in immediately — same day, not "later."
- **STATUS.md** — append-only breadcrumbs: what shipped, what's in flight,
  decisions with dates, next actions. Written at every milestone.
- **docs/specs/** — the contracts; **NN-implementation-notes.md** — the
  implementers' decisions. Together they reconstruct "why is it like
  this?" without archaeology.
- Task board (or equivalent) mirrors in-flight state so the human can
  glance at progress without asking.

## 9. The human's seat

- **Decisions only they can make** get asked explicitly, with recommended
  options — architecture forks, custody/privacy sign-offs, spending money,
  anything irreversible. Record the answer *and date* in the spec it gates.
- **Batch questions**; never nag. Data questions accumulate into one list.
- Report outcomes faithfully: failures with the output, skips as skips.
  When the human says "it seems stuck/boring/wrong," treat it as a process
  bug report — fix the process, then write the rule down (§8).
- Secrets: the human runs anything that displays recovery keys or enters
  credentials; secrets go straight to a keychain/vault; code reads them at
  runtime; they never transit chat or land in files/logs/commits.

## 10. Templates

**Spec skeleton**
```
# Spec NN — <piece>
**vX — date · Status: draft|approved**
Parent: <plan sections>. Depends on: <specs>.
## Goal
## Non-goals
## Pinned conventions        (if any math/ordering/formats involved)
## Deliverables (D1..Dn)
## Testing
## Acceptance criteria       (CI-verifiable vs live, all falsifiable)
## Notes for implementer
```

**Implementation brief skeleton**
```
Implement Spec NN at <path>. Contract: docs/specs/NN-*.md (read fully).
Also read: <implementation notes of everything it builds on>, CLAUDE.md.
Baseline: commit <sha>, <suite> green.
Reality: <installed types / API census / verified endpoints — pasted>.
Constraints: no network in your sandbox — do not run <installs/tests/live>;
I verify. Do not commit. Do not edit specs. Deviations →
docs/specs/NN-implementation-notes.md (one-liners).
Report: what's built, decisions, exact commands I must run, anything deferred.
```

**Review brief skeleton**
```
Adversarially review docs/specs/NN-*.md. READ-ONLY.
Read: <spec, its dependencies, and REAL artifacts to ground in>.
Context: <two sentences>.
Attack: <the 5-8 sharp edges you most fear, named>.
Return BLOCKER/SHOULD-FIX/CONSIDER with section refs + concrete resolutions.
```

**CLAUDE.md operating-rules block** — copy §1's table + the exceptions
line + your project's hard rules (data hygiene, read-only boundaries,
secret handling) + a "process rules learned" section that grows.

## 11. Iterating on the playbook itself

This document is a snapshot of a living process. The meta-rule: every time
something surprises you — an agent behavior, a platform quirk, a human
correction — ask "what rule would have prevented this?", write it into the
project's CLAUDE.md that day, and fold it back here when it generalizes.
The playbook you finish a project with should be visibly better than the
one you started with.
