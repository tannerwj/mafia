// Spec 13: pure role-count resolution helpers for `HostLobby.tsx`, split out
// so they're unit-testable without rendering the component (this repo's
// client tests run in plain Node, no jsdom/testing-library — see
// `test/client/RoomConnection.test.ts`). No React/JSX here.
//
// `tsconfig.client-test.json` (the vitest "client" project) scopes its file
// list to `test/client` + `src/client/net` + `src/client/lib` + `src/shared`
// and deliberately does NOT include `src/engine` — so this file takes the
// recommendation function as a parameter (same injection posture the engine
// itself uses for clock/RNG) instead of importing `recommendedRoleCounts`
// from `../../engine` directly. `HostLobby.tsx` (built under
// `tsconfig.client.json`, which does include `src/engine`) passes the real
// one in.
export type RecommendFn = (playerCount: number) => Record<string, number>;

// The roles the host can dial (villagers are the remainder). Order is the
// stable display order.
export const EDITABLE_ROLES: { id: string; label: string }[] = [
  { id: "mafia", label: "Mafia" },
  { id: "detective", label: "Detective" },
  { id: "angel", label: "Angel" },
  { id: "suicide_bomber", label: "Suicide bomber" },
  { id: "minion", label: "Minion" },
];

export type Counts = Record<string, number>;

// True iff every house-six role in `roles` is still `"auto"` — i.e. the
// ruleset hasn't been touched by a host edit yet (fresh room or after Reset).
export function isAllAuto(roles: Record<string, number | "auto">): boolean {
  return EDITABLE_ROLES.every((r) => roles[r.id] === "auto") && roles.villager === "auto";
}

export function countsFromRecommendation(recommend: RecommendFn, playerCount: number): Counts {
  const rec = recommend(Math.max(playerCount, 1));
  const out: Counts = {};
  for (const { id } of EDITABLE_ROLES) out[id] = rec[id] ?? 0;
  return out;
}

// Resolves the editor's displayed counts from a broadcast ruleset: an
// all-auto ruleset (fresh room / after Reset) resolves via `recommend`;
// otherwise explicit numbers win per-role and any remaining "auto" role
// (shouldn't normally occur once touched) also falls back to the
// recommendation rather than 0.
export function countsFromRuleset(
  recommend: RecommendFn,
  roles: Record<string, number | "auto">,
  playerCount: number,
): Counts {
  if (isAllAuto(roles)) return countsFromRecommendation(recommend, playerCount);
  const rec = countsFromRecommendation(recommend, playerCount);
  const out: Counts = {};
  for (const { id } of EDITABLE_ROLES) {
    const v = roles[id];
    out[id] = typeof v === "number" ? v : (rec[id] ?? 0);
  }
  return out;
}

// Display order + labels for the hint line, per spec example: "4 mafia ·
// 1 minion · 2 detectives · 2 angels · 1 bomber · 6 villagers" — note this
// order (mafia, minion, detective, angel, bomber) differs from the stepper
// editor's display order (`EDITABLE_ROLES`). "mafia" doesn't pluralize
// (matches the spec's own "4 mafia", not "4 mafias").
const HINT_ROLES: { id: string; singular: string; plural: string }[] = [
  { id: "mafia", singular: "mafia", plural: "mafia" },
  { id: "minion", singular: "minion", plural: "minions" },
  { id: "detective", singular: "detective", plural: "detectives" },
  { id: "angel", singular: "angel", plural: "angels" },
  { id: "suicide_bomber", singular: "bomber", plural: "bombers" },
];

// "Suggested for 16: 4 mafia · 1 minion · 3 detectives · 2 angels · 1 bomber
// · 5 villagers" — pluralizes by count, drops zero-count roles, always ends
// with villagers. Never blocks Start; a hint only.
export function suggestionHint(recommend: RecommendFn, playerCount: number): string {
  const n = Math.max(playerCount, 1);
  const rec = recommend(n);
  const parts = HINT_ROLES.filter((r) => (rec[r.id] ?? 0) > 0).map((r) => {
    const count = rec[r.id]!;
    return `${count} ${count === 1 ? r.singular : r.plural}`;
  });
  parts.push(`${rec.villager ?? 0} villager${(rec.villager ?? 0) === 1 ? "" : "s"}`);
  return `Suggested for ${n}: ${parts.join(" · ")}`;
}
