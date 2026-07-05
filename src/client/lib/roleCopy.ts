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
}

const ROLE_COPY: Record<string, RoleCopy> = {
  villager: {
    displayName: "Villager",
    blurb: "No special power. Vote wisely by day.",
  },
  mafia: {
    displayName: "Mafia",
    blurb: "Choose a victim with your partners each night.",
  },
  detective: {
    displayName: "Detective",
    blurb: "Investigate one player each night to learn their allegiance.",
  },
  angel: {
    displayName: "Angel",
    blurb: "Protect one player (including yourself) from the night's attack.",
  },
  suicide_bomber: {
    displayName: "Suicide Bomber",
    blurb: "If the village murders you by vote, you win alone.",
  },
  minion: {
    displayName: "Minion",
    blurb: "You know the mafia's cause, but the mafia may not know you.",
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
