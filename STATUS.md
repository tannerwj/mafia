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
