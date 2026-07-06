# Spec 16 — The front door: landing explainer, SEO, room invites, QR join

**v1 — 2026-07-06 · Status: approved for build (Tanner: "do them all").**
Tier: light-medium (client + static assets + one narrow worker interception;
no engine, no protocol, no game-state surface; delegated + verified,
no adversarial review round; targeted tests). Grounded in the 2026-07-06
SEO/home audit (findings F1–F8). Baseline: `e854b52`.

## Goals

1. A stranger landing on mafia.tannerwj.com understands what this is within
   one scroll — WITHOUT any added friction for the core actions (create /
   join stay exactly where they are, above the fold, first in tab order).
2. Crawlers and link-unfurlers get everything they deserve: canonical,
   JSON-LD, robots directives, per-room invitation cards.
3. Joining an in-person table gets one tap faster: QR code on the host's
   share surface.

## D1 — Landing explainer (Home.tsx)

Keep the existing hero EXACTLY as-is (case-file eyebrow, MAFIA h1,
CONFIDENTIAL stamp, tagline, "Open a new case", file-number join form —
all current testids unchanged; the E2E suite's createRoomAsHost/join
helpers must keep passing untouched).

BELOW the fold (scroll), add an explainer in the same Case File idiom:

- **"The pitch"** (2–3 sentences): social-deduction party game for one
  room, in person; phones replace cards and the sleeping narrator; the app
  deals roles, runs the night, counts the votes — the table does the
  yelling. No accounts, no app install, no cards.
- **"How a game runs"** — 4 numbered beats (numbering is genuinely
  sequential): 1 someone opens a case and shares the link/QR; 2 everyone
  joins on their phone, roles are dealt in secret; 3 nights are silent
  (killers, detective, angel act on their phones — everyone else files a
  decoy so nothing is given away); 4 days are loud — accuse, defend, vote.
  Last faction standing wins.
- **"The cast"** — one line each for the house six (mafia, detective,
  angel, suicide bomber, minion, villager) reusing copy/tone from
  roleCopy.ts (don't invent new role descriptions — reuse or lightly adapt).
- **"House facts"** strip: 5–20 players (3+ with a narrator running counts),
  ~15–45 minutes, one host phone runs the table, optional AI storyteller
  for the narrator.
- Footer: quiet one-liner + link that opens the existing How-to-play
  content (reuse the in-room instructions modal component if it mounts
  cleanly outside a room; otherwise link a #how-it-works anchor — do NOT
  duplicate instruction copy in two places).

Copy register: match the existing noir voice ("case", "subjects",
"the office") but the explainer must be COMPREHENSIBLE first, atmospheric
second — a reader who has never heard of Mafia/Werewolf must get it.

## D2 — SEO hygiene (static, index.html + public/)

- `<link rel="canonical" href="https://mafia.tannerwj.com/">` (F1).
- `public/robots.txt` (F2): allow `/`, `Disallow: /room/` for all agents,
  reference sitemap. (Cloudflare's zone-managed Content Signals prepends
  itself to origin robots.txt — ours only needs the crawl rules.)
- `public/sitemap.xml` (F5): the single canonical URL.
- JSON-LD in index.html `<head>` (F4): `WebApplication` schema — name,
  url, description, applicationCategory "GameApplication", isAccessibleForFree
  true, operatingSystem "Any (web)". Keep it truthful and minimal.
- Web manifest: add `screenshots` array (F8) — orchestrator will capture
  two real screenshots (landing + in-game vote) and drop them in public/
  as manifest-screenshot-{1,2}.png; reference them (form_factor "narrow").
  Builder: wire the manifest entries; placeholder-safe if files land after.
- SKIP twitter:site (F6) — no account to attribute; noted, not built.

## D3 — Per-room invitation cards + noindex (worker, narrow)

New, narrow interception in `src/server/index.ts`: for GET requests whose
path matches `^/room/[A-Z0-9]{5}$` (case-insensitive) AND whose `Accept`
includes `text/html`, fetch the SPA asset response as today, then rewrite
via `HTMLRewriter`:

- `og:title` → `You're invited to a game of Mafia — case {CODE}`
- `og:description` → `Tap the link, sign the register, and try to survive
  the night. No app needed.`
- `twitter:title` / `twitter:description` → same values
- Inject `<meta name="robots" content="noindex">` (F7)
- `og:url` → the room URL

Constraints: NO DO lookup, NO storage read, NO room-existence check — the
rewrite is a pure string transform of the code from the URL (uppercase it),
zero information disclosure (the code was already in the URL), zero added
latency class. Everything else (title tag, assets, SPA behavior) unchanged.
Non-HTML and non-matching paths take today's exact path untouched.

## D4 — QR join (host share surface)

- On the host lobby share card, alongside SHARE LINK: render a QR code of
  the room URL, sized for a phone camera across a table (~200-240px,
  high contrast against the paper/ink palette — QR must remain scannable:
  dark modules on light background, quiet zone respected; don't invert to
  match the noir theme if it hurts scanning — put it on a paper-light tile).
- Implementation: a tiny dependency-light QR encoder. Orchestrator will run
  the install; propose the package in your notes BEFORE using it (suggest
  `qrcode` or a zero-dep alternative); render to canvas or SVG client-side.
  No network calls, no external QR image services (CSP + privacy).
- Also show the QR in the narrator/host view while the game is in the
  lobby ONLY (a mid-game QR invites latecomers who can't join anyway —
  don't show it once the game starts).

## Tests (land with the build)

- Existing E2E must stay green untouched (hero testids stable).
- New E2E: landing shows explainer sections (testids); QR canvas/svg
  renders on host lobby with the room code in its data URL/title attr;
  QR absent once game starts.
- Server test (pool-workers): GET /room/ABCDE with Accept text/html
  returns HTML containing `You're invited` + `noindex` + the code;
  GET / unchanged (no noindex, canonical present via static asset);
  GET /room/ABCDE with non-HTML accept → untouched asset behavior;
  /api/* unaffected.
- Unit: whatever QR wrapper logic exists (encode input = full room URL).

## Non-goals

Prerendering/SSR (Google/Bing render JS; JSON-LD + meta carry the rest).
Blog/marketing pages. Analytics (Spec 17). PWA service worker/offline.
Changing the create/join flow in any way.
