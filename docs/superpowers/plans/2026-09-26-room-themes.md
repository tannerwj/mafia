# Room Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three host-selected, room-wide visual themes and improve the shared mobile game hierarchy without changing game rules or visibility.

**Architecture:** One authoritative `visualTheme` is stored by the Durable Object and included in every room snapshot. One React tree consumes that value, sets a stable theme attribute, and uses semantic CSS tokens for three skins. Shared layout and feedback improvements apply identically to every theme.

**Tech Stack:** TypeScript, Cloudflare Workers Durable Objects, React 19, Vite 7, Tailwind 4, Playwright.

---

## Files and boundaries

- `src/shared/protocol.ts`: public theme union, snapshot field, host command.
- `src/server/game-room.ts`: validation, storage, authorization, snapshot projection.
- `src/client/store/gameStore.ts`: sending the host command.
- `src/client/App.tsx` or a small dedicated theme component: reflect the authoritative snapshot on the document and reset on home.
- `src/client/index.css`: semantic theme tokens, decorative treatments, motion and reduced-motion rules.
- `src/client/screens/host/HostLobby.tsx`: three-option preview/selection and clearer setup sequence.
- `src/client/screens/Home.tsx`, `Lobby.tsx`, `game/*`, `host/HostGame.tsx`: shared hierarchy and feedback.
- `test/e2e/`: visible-control theme/reconnect/rematch/privacy journey.
- `docs/specs/23-implementation-notes.md`: deviations, measurements, verification notes.

## Task 1 — Authoritative theme contract

- [ ] Record the existing `data-testid` set and baseline build sizes. The baseline on 2026-09-26 is client JS 433.61 KB raw / 130.19 KB gzip, CSS 32.24 KB raw / 7.08 KB gzip.
- [ ] Add the closed union and message to `src/shared/protocol.ts` and the theme field to `ClientRoomState`; keep narrator theme separate.
- [ ] Extend `src/server/game-room.ts` `RoomMeta` with `visualTheme` and `visualThemeRevision`, defaulting older rooms to `atelier`/`0`, a lobby-only host command, and snapshot inclusion. Reuse the existing `sendRejection` and broadcast patterns; reject unknown wire values at runtime. Increment the revision on each changed theme and preserve it through rematch.
- [ ] Add the client store command that sends `{ type: "set_visual_theme", visualTheme }`.
- [ ] Run `npm run typecheck`; resolve all protocol consumers before proceeding.

## Task 2 — One design system, three skins

- [ ] Introduce `data-visual-theme` on `document.documentElement` from `room.visualTheme`; use `atelier` on home and before welcome. This covers Radix portals, Sonner, and the global grain layer. Ignore lower theme revisions if host-tab broadcasts arrive out of order. Confirm a route change or room switch cannot leave an old theme behind.
- [ ] Define semantic tokens for surface, text, muted, border, accent, action, danger, focus, and shadow in `src/client/index.css`; map the existing Tailwind color utilities to them. Define Atelier, Club, and Rain palettes and ornament without downloaded assets or new runtime packages.
- [ ] Theme toasts, dialogs, overlays, status chips, and QR surroundings. Keep the QR tile light, decorative layers untappable, phase fading interruptible, and reduced motion instant.
- [ ] Build and record the new JS/CSS sizes. Verify there are no new external asset requests.

## Task 3 — Host theme selection and setup clarity

- [ ] In `HostLobby.tsx`, add three options with human-readable names and selected/saving/saved feedback. Send the selection, then derive the active skin and chosen option from the next authoritative snapshot; a rejection shows an error. Label the picker “Table look” and the Storyteller's free-text field “Story setting.”
- [ ] Reorder the host lobby visually around room sharing, joined seats, theme and roles, and Start. The QR stays available but should no longer push the whole configuration below a full-screen tile.
- [ ] Make the Start blocked reason adjacent to the disabled control. Preserve suggested role counts, host-only controls, Storyteller, and all house-rule options.
- [ ] On 320/360/390px and 1024px, check no overflow, 44px targets, focus, and real taps.

## Task 4 — Shared player and host hierarchy

- [ ] Improve Home's first viewport: readable game identity, clear Create/Join distinction, useful one-sentence explanation, and accessible help link.
- [ ] In player Lobby, show own seat, joined count, expected next step, and concise privacy guidance without exposing a role.
- [ ] In player game screens, put phase/day, literal task, valid choices, and confirmation in a clear reading order. Preserve the universal decoy interaction, Spec 04's one-time five-second assignment reveal and private subsequent reloads, projected data only, and the existing test IDs.
- [ ] In host game screens, put current phase/progress and the next allowed action first. Keep force/absence/log/scene/narrator features reachable with their existing confirmations.
- [ ] After each consequential action, confirm what was accepted and whether it may be changed. Avoid copy that claims the host can reveal or advance before the engine allows it.

## Task 5 — E2E and independent verification

- [ ] Extend the multi-context Playwright suite with visible-control selection of all three themes, player sync, reload, new-context rejoin, rematch persistence, rejected player commands, and identical game controls in each theme. Leave a rerunnable test file and exact command in implementation notes.
- [ ] Run `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build` in an isolated test server/state directory. Do not delete state with a live server.
- [ ] Capture baseline/after 320/360/390px screenshots of home, host/player lobby, night, day, results, dead view, and end; 1024px host board. Check keyboard focus, reduced motion, safe areas, contrast, no overflow, console errors, and real tap paths.
- [ ] Compare asset sizes and representative interaction/transition timings to the baseline; record any regression and its cause. Keep production untouched.

## Handoff

Implementers edit application/test files only and do not commit. The orchestrator reviews screenshots and commands, runs fresh checks, commits after verification, and owns any later release decision. This plan follows [Spec 23](../../specs/23-room-themes-and-ux.md); if a detail conflicts, the spec wins.
