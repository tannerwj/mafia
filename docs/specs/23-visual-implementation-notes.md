# Spec 23 visual implementation notes

## Scope

This pass implements the D2 visual foundation and D3 home, player lobby, and
host lobby surfaces. It keeps one React component tree and the existing test
IDs and game actions. The host lobby sends the authoritative
`set_visual_theme` command; it never applies a local skin before the room
snapshot confirms the change.

## Visual decisions

- `data-visual-theme` is set on `document.documentElement` from the room
  snapshot in `App.tsx`; it is accepted only when the snapshot room code
  matches the active route. Home and pre-snapshot states use `atelier`, which
  prevents a previous room's skin flashing during navigation. Route object
  changes are treated as pre-welcome too, because the client retains its last
  snapshot while a new room authentication handshake is resolving.
- Existing `--color-*` Tailwind tokens remain stable, but resolve through
  semantic room tokens for Atelier, Club, and Rain. The global grain,
  phase-ambiance washes, redaction bars, focus rings, and toast surface use
  those tokens instead of a hard-coded Atelier cast.
- The three options keep the same labels, order, controls, and interaction
  semantics. Their preview swatches are decorative and are not tied to roles,
  phases, or factions.
- The skins now have distinct typographic and framing systems: Atelier uses a
  serif editorial display with sans body, Club uses a Didot/Bodoni-style
  display and double-rule geometry, and Rain uses a crisp sans system with
  solid cobalt lines and restrained glow.
- The QR remains on a solid white tile. There are no new network assets,
  downloaded fonts, dependencies, canvas layers, or WebGL.
- The Storyteller's free-text narrator field is labeled `Story setting`
  separately from the room's `Table look` picker.

## Layout changes

- Home now uses a compact two-column desktop / stacked phone hero with a
  literal game description and paired Create / Join actions in the first
  viewport. The primary hero and action card mount without an opacity entrance
  animation so slow phones never show an initially invisible start surface;
  dialog and secondary surfaces may still use the short rise animation.
- The player lobby leads with room code, joined count, own seat, privacy
  reminder, and an explicit next-step message.
- The host lobby presents a four-step setup strip, compact share card with QR,
  player progress, room-wide Table look picker, role editor, scene setting,
  Story setting, and the start gate with its reason adjacent to the button.
- At widths up to 380px, the host QR sits beside the code/share content at a
  104px displayed canvas (150px backing resolution) while retaining the
  `room-qr` canvas and URL semantics. The share action compresses its label at
  the narrowest width to avoid horizontal overflow.

## Deviations / follow-up

- Rejection feedback for a theme command continues to use the store's shared
  toast. The host picker clears its local `Saving…` state after five seconds if
  no authoritative snapshot confirms the requested value. A newer snapshot
  from another host tab cancels that timeout and remains the sole selected
  value.
- This implementer did not run Playwright, deploy, or change game screens;
  the orchestrator owns the isolated E2E and live UI verification gates. The
  room theme E2E artifact includes a same-room SPA re-entry check that holds
  the new welcome/snapshot and asserts Atelier until the authoritative frame
  is released.
