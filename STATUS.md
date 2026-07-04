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
