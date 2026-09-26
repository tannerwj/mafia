# Spec 20 — Action feedback and first-time clarity

**v1 — 2026-09-26 · Status: approved for light UX build**

## Goal

Consequential taps never disappear silently during a connection drop. A first-time player entering by QR/link can reach correct rules, and keyboard users can operate the landing instructions dialog. Preserve the noir identity and game rules.

## Deliverables

1. Make `RoomConnection.send` report whether the WebSocket accepted the command. The store surfaces one concise toast if a consequential send is attempted while the socket is not open: “Connection lost. Reconnect, then try again.” Do not queue commands, imply they were committed, or apply optimistic game state. Keep existing server rejection handling. Avoid toast spam if a user taps repeatedly during one disconnect. A successful reconnect clears the suppression.
2. Update `Instructions.tsx` night copy to the actual uniform flow: every living player picks and confirms; non-power roles make an inert “Keep watch” decoy pick. Do not reveal other players' roles or targets in this copy.
3. Add the existing HelpButton to the direct room join/seat-picker path so QR/link visitors can read instructions before entering a name. Label the name input, associate validation errors with it, and announce errors with `role="alert"`.
4. Replace the landing page's handwritten instructions dialog with the shared accessible dialog primitive already used by in-game Help, or implement equivalent focus behavior: focus enters on open, Tab/Shift+Tab stay in the dialog, Escape closes, focus returns to the opener. Keep click-to-close and existing test IDs.
5. Give the “no murder” day vote a clear label containing “No murder this round” without changing its protocol target. Give the reconnect banner status semantics and add a visible keyboard focus indicator to hand-written interactive controls touched here.

## E2E artifact

Extend `test/e2e/game-reconnect.spec.ts`: after dropping a room socket and observing the reconnect banner, tap a consequential night or vote control. Assert explicit blocked feedback, no fake locked/confirmed state, and server snapshot recovery after reconnect. Add a landing-dialog keyboard test to `front-door.spec.ts`: open by keyboard, verify focus enters and remains inside, Escape returns focus. Use an isolated port/state directory per runner.

## Verification

Orchestrator runs typecheck, full tests, full E2E, build, and a 360 px visual pass. No unit tests for these reversible UI changes. Implementer records deviations in `docs/specs/20-implementation-notes.md`, does not edit this spec, and does not commit.
