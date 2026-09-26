# Room-wide visual themes and shared game UX

**Decision, 2026-09-26:** Tanner approved three themes: Noir Atelier (default), Midnight Club, and Neon Rain. The host chooses one theme for the entire room. Themes have distinct art direction and motion, with the same controls in the same places.

## Why

The shipped Case File UI has a coherent noir identity, but its system monospace body copy, dense framed controls, and large empty regions weaken reading hierarchy on a phone. The host lobby gives substantial space to the QR before the host can see the setup path. The player night screen leaves the main decision visually detached from phase context. The game is functional; this work makes its next action immediately legible and gives each table a mood without altering play.

## Experience

Every room has one public, server-owned `visualTheme`. The host selects it in the lobby and sees the result when the server broadcasts its snapshot. All connected phones receive the choice in the same authoritative room snapshot. A reconnect, tab reload, new device, and rematch recover the same theme. Theme controls disappear during a game; the host can choose again in the rematch lobby. Home and rooms before their first snapshot render the default Noir Atelier.

The information architecture is shared across themes. On a player screen, phase and day identify the moment, a short sentence names the task, the valid choices occupy the central area, and a single consequential action is easy to reach near the bottom. The resulting state says what was recorded and what happens next. The host board leads with progress, the next allowed action, and the reason it is or is not available. Secondary rules, logs, and force controls remain findable without competing with the main action. The join/lobby path explains room, seat, roster, and start status in that order.

| Theme | Mood and palette | Treatment |
|---|---|---|
| Noir Atelier | Editorial detective dossier; black ink, warm cream, oxblood and restrained brass | Fine rules, subtle paper texture, large restrained serif headlines, readable system sans body |
| Midnight Club | Art Deco supper club; deep emerald, champagne and warm ivory | Geometric frames, soft gold highlights, elegant condensed headings |
| Neon Rain | Contemporary city noir; blue-black, electric cobalt and amber | Clean grids, sparse light accents, abstract rain/glass texture at very low opacity |

The approved theme previews are mood boards. Their generated people, role-like labels, readiness claims, and host instructions are **not** source material for game data or copy. The implemented UI must render only the existing server projection. No theme may color-code a role, reveal a different number of steps for a role, or alter the decoy-action pattern.

## Technical approach

Use one React component tree and a `data-visual-theme` attribute with semantic CSS variables. Keep the existing `data-testid` and phase contracts. Avoid remote assets, CDN fonts, new runtime dependencies, animated canvas, and WebGL. Prefer system serif/sans stacks and lightweight CSS motifs. Make ornament `pointer-events:none`. Let container queries adapt reusable panels; use them as progressive enhancement. Keep the current interruptible ~300 ms phase transition as the behavioral baseline. Any View Transition API use is optional, checks support, and never delays a snapshot; reduced motion removes nonessential movement.

Extend `src/shared/protocol.ts` with a closed theme union, `ClientRoomState.visualTheme` and revision, and host-only `set_visual_theme`. Validate and persist them in the Durable Object's room metadata. Missing stored values from older rooms default to Noir Atelier and revision zero. Accept only in lobby, reject player requests and unknown values, broadcast the resulting snapshot, and ignore an older theme revision if broadcasts cross. Set the theme attribute at document root so dialogs, toasts, and texture inherit it. Keep the AI Storyteller's free-text `story.settings.theme` separate; it describes narration and does not drive the visual skin. Preserve the theme through `new_game`. Preserve the existing one-time five-second role reveal; later reloads stay hidden.

## Acceptance

At 320, 360, and 390 px, joining, setup, night, day vote, results, dead view, end, and rematch have no horizontal overflow and a clear next action. Theme choice survives reload, disconnected rejoin, two host tabs, and rematch; a player cannot change it. Three themes show identical choices, disabled states, privacy treatment, and action order for the same projected snapshot. Consequential actions show immediate feedback and remain keyboard and screen-reader usable. Reduced motion and safe areas work on phones. Record before/after compressed assets and representative tap/phase timings; reject avoidable regression.

## Research basis

- [MDN: same-document View Transitions](https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition) supports progressive enhancement, with a fallback for older browsers.
- [MDN: container size and style queries](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Container_size_and_style_queries) supports layout components that respond to their container.
- [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion) provides the required motion preference hook.
- [Jackbox accessibility feature notes](https://www.jackboxgames.com/blog/accessibility-features-in-the-jackbox-party-pack-10) reinforce clear phone controls and player-specific accessibility options in party games; this app keeps its shared theme while honoring each phone's motion preference.

## Tradeoffs

One shared tree limits each theme's layout freedom but keeps the game learnable and makes privacy parity testable. System fonts and CSS art will be less extravagant than bitmap-heavy concept art, but keep load and rendering predictable on older phones. Lobby-only theme changes avoid a surprise reskin during a secret action; the host can reset the mood between rounds.
