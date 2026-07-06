// Spec 13: unit coverage for the pure role-count resolution helpers used by
// `HostLobby.tsx` (split into `src/client/lib/hostRoleCounts.ts` so they're
// testable without rendering — same posture as RoomConnection.test.ts /
// shareLink.test.ts: plain Node, no jsdom). These helpers take the
// recommendation function as a parameter (this test project's tsconfig
// excludes `src/engine`), so this test hand-rolls a fixture recommend()
// that mirrors the real `recommendedRoleCounts` at the sizes exercised here —
// the real function's exact values are pinned separately in
// `test/engine/recommendation.test.ts`.
import { describe, expect, test } from "vitest";
import {
  countsFromRecommendation,
  countsFromRuleset,
  isAllAuto,
  suggestionHint,
  type RecommendFn,
} from "../../src/client/lib/hostRoleCounts";

const FIXTURE_TABLE: Record<number, Record<string, number>> = {
  1: { mafia: 1, detective: 0, angel: 0, suicide_bomber: 0, minion: 0, villager: 0 },
  16: { mafia: 4, detective: 3, angel: 2, suicide_bomber: 1, minion: 1, villager: 5 },
  20: { mafia: 5, detective: 3, angel: 2, suicide_bomber: 1, minion: 1, villager: 8 },
};
const recommend: RecommendFn = (n) => {
  const row = FIXTURE_TABLE[n];
  if (!row) throw new Error(`no fixture row for n=${n}`);
  return row;
};

describe("isAllAuto", () => {
  test("true when every house-six role is auto", () => {
    expect(
      isAllAuto({
        mafia: "auto",
        villager: "auto",
        detective: "auto",
        angel: "auto",
        suicide_bomber: "auto",
        minion: "auto",
      }),
    ).toBe(true);
  });

  test("false when any role is explicit", () => {
    expect(
      isAllAuto({
        mafia: 2,
        villager: "auto",
        detective: "auto",
        angel: "auto",
        suicide_bomber: "auto",
        minion: "auto",
      }),
    ).toBe(false);
  });

  test("false when villager is explicit", () => {
    expect(
      isAllAuto({
        mafia: "auto",
        villager: 0,
        detective: "auto",
        angel: "auto",
        suicide_bomber: "auto",
        minion: "auto",
      }),
    ).toBe(false);
  });
});

describe("countsFromRecommendation", () => {
  test("resolves the editable-role subset from the injected recommend()", () => {
    expect(countsFromRecommendation(recommend, 16)).toEqual({
      mafia: 4,
      detective: 3,
      angel: 2,
      suicide_bomber: 1,
      minion: 1,
    });
  });

  test("clamps to n=1 at playerCount=0 (no crash while the lobby is empty)", () => {
    expect(countsFromRecommendation(recommend, 0)).toEqual(countsFromRecommendation(recommend, 1));
  });
});

describe("countsFromRuleset", () => {
  test("all-auto ruleset resolves via the recommendation", () => {
    const roles = {
      mafia: "auto" as const,
      villager: "auto" as const,
      detective: "auto" as const,
      angel: "auto" as const,
      suicide_bomber: "auto" as const,
      minion: "auto" as const,
    };
    expect(countsFromRuleset(recommend, roles, 20)).toEqual(countsFromRecommendation(recommend, 20));
  });

  test("explicit numbers win per-role; a lingering auto role falls back to the recommendation", () => {
    const roles = {
      mafia: 6,
      villager: "auto" as const,
      detective: 0,
      angel: "auto" as const,
      suicide_bomber: 1,
      minion: 0,
    };
    const result = countsFromRuleset(recommend, roles, 16);
    const rec = countsFromRecommendation(recommend, 16);
    expect(result.mafia).toBe(6);
    expect(result.detective).toBe(0);
    expect(result.suicide_bomber).toBe(1);
    expect(result.minion).toBe(0);
    expect(result.angel).toBe(rec.angel);
  });
});

describe("suggestionHint", () => {
  test("N=16 hint lists every nonzero role, pluralized, ending with villagers", () => {
    expect(suggestionHint(recommend, 16)).toBe(
      "Suggested for 16: 4 mafia · 1 minion · 3 detectives · 2 angels · 1 bomber · 5 villagers",
    );
  });

  test("N=1 hint has no zero-count roles and singular villager", () => {
    expect(suggestionHint(recommend, 1)).toBe("Suggested for 1: 1 mafia · 0 villagers");
  });

  test("clamps to n=1 at playerCount=0", () => {
    expect(suggestionHint(recommend, 0)).toBe(suggestionHint(recommend, 1));
  });
});
