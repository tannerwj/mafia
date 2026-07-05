// Display-only copy for role names/descriptions, keyed by the `roleId`
// strings the projection sends over the wire (`src/shared/game-view.ts`'s
// `RoleId = string`). This is a client-local mirror of
// `src/engine/roles.ts`'s `HOUSE_ROLE_DEFS` display names — NOT an import
// from `src/engine` (this spec is client-only and must not depend on the
// engine package), and it carries no game logic, only strings for
// rendering. If the projection ever sends a roleId this map doesn't know
// about, the fallback is the raw id, title-cased — never a thrown error.
export interface RoleCopy {
  displayName: string;
  blurb: string;
  /** Longer form, for the Instructions modal's role-by-role reference
   * (Spec 08 D4) — falls back to `blurb` when a role has nothing more to
   * say than its one-liner. Not shown in RoleReveal/HoldToPeek (those stay
   * on `blurb`, unchanged), only in the Instructions modal. */
  instructionsBlurb?: string;
}

const ROLE_COPY: Record<string, RoleCopy> = {
  villager: {
    displayName: "Villager",
    blurb: "No special power. Vote wisely by day.",
    instructionsBlurb: "No special power. Your only tool is the day vote — talk, listen, and vote out whoever you believe is Mafia.",
  },
  mafia: {
    displayName: "Mafia",
    blurb: "Choose a victim with your partners each night.",
    instructionsBlurb: "Each night, the Mafia team picks a target together. You can see your partners' tentative picks live and must lock in your choice — the kill only happens once your team's lock-in rule is satisfied. By day, blend in and vote like a villager.",
  },
  detective: {
    displayName: "Detective",
    blurb: "Investigate one player each night to learn their allegiance.",
    instructionsBlurb: "Each night, investigate one other player to learn whether they're Mafia. Use what you learn to guide the village's votes by day — but be careful revealing your role, or you become a target.",
  },
  angel: {
    displayName: "Angel",
    blurb: "Protect one player (including yourself) from the night's attack.",
    instructionsBlurb: "Each night, choose one living player (including yourself) to protect. If the Mafia targets your protected player that night, the attack fails.",
  },
  suicide_bomber: {
    displayName: "Suicide Bomber",
    blurb: "If the village murders you by vote, you win alone.",
    instructionsBlurb: "You win alone, instantly, if the village votes you out by day. A night kill on you is just a normal death — only a day-vote elimination triggers your win. You have no night action.",
  },
  minion: {
    displayName: "Minion",
    blurb: "You know the mafia's cause, but the mafia may not know you.",
    instructionsBlurb: "You know who the Mafia are from the start of the game and win alongside them, but you have no night action and the Mafia may not know you're on their side. You still count toward the Mafia team's parity for winning.",
  },
};

function titleCase(id: string): string {
  return id
    .split(/[_-]/)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function roleCopyFor(roleId: string): RoleCopy {
  return (
    ROLE_COPY[roleId] ?? {
      displayName: titleCase(roleId),
      blurb: "",
    }
  );
}

/** The house six, in a stable display order — for the Instructions modal's
 * "every role" reference (Spec 08 D4). Not derived from the engine's
 * `HOUSE_ROLE_DEFS` (this module stays engine-import-free); a hand-kept
 * mirror of the same six ids, same reasoning as the rest of this file. */
export const HOUSE_ROLE_IDS = ["villager", "mafia", "detective", "angel", "suicide_bomber", "minion"] as const;
