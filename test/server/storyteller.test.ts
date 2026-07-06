import { describe, expect, test } from "vitest";
import {
  BEAT_PHASE,
  buildPrompt,
  buildStoryFacts,
  extractRawText,
  fakeStoryOutput,
  isAtmosphereBeat,
  parseStoryOutput,
  type StoryFacts,
} from "../../src/server/storyteller";
import type { ClientGameView } from "../../src/shared/game-view";
import type { BeatId } from "../../src/shared/protocol";

// ---------------------------------------------------------------------------
// Minimal hand-built `ClientGameView` fixtures — these stand in for
// `projectFor(state, {kind:"public"})` output (the game-room integration
// tests in game-room.test.ts exercise the REAL projection end to end; these
// unit tests exercise buildStoryFacts/prompt/parsing in isolation against a
// deliberately-crafted view, including a view that carries fields
// buildStoryFacts must NOT read for an atmosphere beat).
// ---------------------------------------------------------------------------

function baseView(overrides: Partial<ClientGameView> = {}): ClientGameView {
  return {
    phase: "dawn",
    day: 2,
    deadlineAt: null,
    phaseGen: 5,
    players: [
      { id: "p1", alive: true, absent: false },
      { id: "p2", alive: false, absent: false },
      { id: "p3", alive: true, absent: false },
    ],
    log: [],
    winners: null,
    rolesRemaining: [{ roleId: "villager", count: 2 }],
    graveyard: [{ playerId: "p2", day: 1, cause: "night", roleId: "mafia", alignment: "evil" }],
    headcount: { alive: 2, total: 3 },
    ...overrides,
  };
}

const nameOf = (id: string) => ({ p1: "Alice", p2: "Bob", p3: "Carol" })[id] ?? id;

describe("Spec 15: BEAT_PHASE / isAtmosphereBeat pinning", () => {
  test("legal-phase table matches the spec exactly", () => {
    expect(BEAT_PHASE).toEqual({
      "sunrise-hold": "sunrise",
      "sunset-hold": "sunset",
      "morning-report": "dawn",
      "post-vote": "dusk",
      epilogue: "ended",
    } satisfies Record<BeatId, ClientGameView["phase"]>);
  });

  test("atmosphere beats are exactly sunrise-hold/sunset-hold", () => {
    expect(isAtmosphereBeat("sunrise-hold")).toBe(true);
    expect(isAtmosphereBeat("sunset-hold")).toBe(true);
    expect(isAtmosphereBeat("morning-report")).toBe(false);
    expect(isAtmosphereBeat("post-vote")).toBe(false);
    expect(isAtmosphereBeat("epilogue")).toBe(false);
  });
});

describe("Spec 15: buildStoryFacts — structural guard + leak contract", () => {
  test("throws when the beat's legal phase doesn't match the view's current phase", () => {
    const view = baseView({ phase: "night" });
    expect(() => buildStoryFacts(view, "sunrise-hold", nameOf)).toThrow();
    expect(() => buildStoryFacts(view, "morning-report", nameOf)).toThrow();
  });

  test("atmosphere beat (sunrise-hold) facts carry ONLY day/phase/roster — never deaths/log/votes, even if the view happens to carry them", () => {
    // Deliberately construct a view that DOES carry a graveyard entry and a
    // playerDied log event — an unresolved sunrise view should never have
    // these in practice (Spec 12), but buildStoryFacts's atmosphere branch
    // must not read them even if a caller somehow handed them in. This is
    // the structural guard the spec calls for: "impossible to enrich a hold
    // beat with resolution data by construction."
    const view = baseView({
      phase: "sunrise",
      graveyard: [{ playerId: "p2", day: 2, cause: "night", roleId: "mafia", alignment: "evil" }],
      log: [{ type: "playerDied", playerId: "p2", roleId: "mafia", cause: "night", day: 2 }],
    });
    const facts = buildStoryFacts(view, "sunrise-hold", nameOf);
    expect(facts.kind).toBe("atmosphere");
    expect(facts).not.toHaveProperty("deaths");
    expect(facts).not.toHaveProperty("voteOutcome");
    expect(facts).not.toHaveProperty("attackFailed");
    expect(JSON.stringify(facts)).not.toContain("mafia");
    expect(JSON.stringify(facts)).not.toContain("playerDied");
  });

  test("report beat (morning-report) facts include graveyard/attackFailed derived from the view", () => {
    const view = baseView({
      phase: "dawn",
      log: [{ type: "attackAttempted", day: 2, actorId: "p1", targetId: "p2", attack: "basic", defense: "none", outcome: "landed" }],
    });
    const facts = buildStoryFacts(view, "morning-report", nameOf) as Extract<StoryFacts, { kind: "report" }>;
    expect(facts.kind).toBe("report");
    expect(facts.deaths).toEqual([{ name: "Bob", cause: "night", roleWord: "mafia" }]);
    expect(facts.attackFailed).toBe(false);
  });

  test("report beat never includes a `roster` entry for a player id not on the view (no identity source beyond the projection)", () => {
    const view = baseView({ phase: "ended", winners: ["village"] });
    const facts = buildStoryFacts(view, "epilogue", nameOf);
    expect(facts.roster.map((r) => r.name)).toEqual(["Alice", "Bob", "Carol"]);
  });

  test("vote outcome is always included when present regardless of tallies; tallies forwarded only when the view itself carries view.votes (already gated upstream by projectFor)", () => {
    const withTallies = baseView({
      phase: "dusk",
      log: [{ type: "voteResolved", eliminatedId: "p2", day: 2, reason: "plurality" }],
      votes: [{ playerId: "p1", target: "p2" }],
    });
    const factsWithTallies = buildStoryFacts(withTallies, "post-vote", nameOf) as Extract<StoryFacts, { kind: "report" }>;
    expect(factsWithTallies.voteOutcome).toEqual({ eliminatedName: "Bob", reason: "plurality" });
    expect(factsWithTallies.tallies).toEqual([{ voterName: "Alice", targetName: "Bob" }]);

    const withoutTallies = baseView({
      phase: "dusk",
      log: [{ type: "voteResolved", eliminatedId: "p2", day: 2, reason: "plurality" }],
      // votes intentionally absent — mirrors a `votingVisibility: "hidden"` room.
    });
    const factsWithoutTallies = buildStoryFacts(withoutTallies, "post-vote", nameOf) as Extract<StoryFacts, { kind: "report" }>;
    expect(factsWithoutTallies.voteOutcome).toEqual({ eliminatedName: "Bob", reason: "plurality" });
    expect(factsWithoutTallies.tallies).toBeUndefined();
  });

  test("a no-elimination vote outcome (eliminatedId null) is represented, never a name", () => {
    const view = baseView({
      phase: "dusk",
      log: [{ type: "voteResolved", eliminatedId: null, day: 2, reason: "no_murder" }],
    });
    const facts = buildStoryFacts(view, "post-vote", nameOf) as Extract<StoryFacts, { kind: "report" }>;
    expect(facts.voteOutcome).toEqual({ eliminatedName: null, reason: "no_murder" });
  });
});

describe("Spec 15: prompt contract", () => {
  test("system prompt encodes the word cap, cast limit, and plain-prose instruction", () => {
    const facts = buildStoryFacts(baseView({ phase: "dawn" }), "morning-report", nameOf);
    const { system } = buildPrompt({ settings: { theme: "", tone: "noir" }, memory: { bible: {}, scenes: [] }, facts });
    expect(system).toMatch(/50-90 words/);
    expect(system).toMatch(/Never exceed 90 words/);
    expect(system).toMatch(/3-4 cast members/);
    expect(system).toMatch(/at most 2 new ones/);
    expect(system).toMatch(/no stage directions/);
  });

  test("atmosphere beats add the explicit unresolved-outcome instruction; report beats do not", () => {
    const atmosphereFacts = buildStoryFacts(baseView({ phase: "sunrise" }), "sunrise-hold", nameOf);
    const { system: atmosphereSystem } = buildPrompt({ settings: { theme: "", tone: "noir" }, memory: { bible: {}, scenes: [] }, facts: atmosphereFacts });
    expect(atmosphereSystem).toMatch(/NOT yet resolved/);
    expect(atmosphereSystem).toMatch(/MUST NOT kill, harm, or reveal/);

    const reportFacts = buildStoryFacts(baseView({ phase: "dawn" }), "morning-report", nameOf);
    const { system: reportSystem } = buildPrompt({ settings: { theme: "", tone: "noir" }, memory: { bible: {}, scenes: [] }, facts: reportFacts });
    expect(reportSystem).not.toMatch(/NOT yet resolved/);
  });

  test("facts are wrapped in a fenced JSON data block, not inline instructions", () => {
    const facts = buildStoryFacts(baseView({ phase: "dawn" }), "morning-report", nameOf);
    const { user } = buildPrompt({ settings: { theme: "", tone: "cozy" }, memory: { bible: {}, scenes: [] }, facts });
    expect(user).toContain("```json");
    expect(user).toContain(JSON.stringify(facts));
  });

  test("every tone produces a distinct tone line", () => {
    const facts = buildStoryFacts(baseView({ phase: "dawn" }), "morning-report", nameOf);
    const tones = ["noir", "cozy", "horror", "comedy", "absurd"] as const;
    const systems = tones.map((tone) => buildPrompt({ settings: { theme: "", tone }, memory: { bible: {}, scenes: [] }, facts }).system);
    expect(new Set(systems).size).toBe(tones.length);
  });
});

describe("Spec 15: defensive output parsing", () => {
  test("extracts Workers AI's {response} shape", () => {
    expect(extractRawText({ response: "hello" })).toBe("hello");
  });

  test("extracts OpenAI-style {choices[0].message.content} shape", () => {
    expect(extractRawText({ choices: [{ message: { content: "hello" } }] })).toBe("hello");
  });

  test("strips <think> blocks before parsing", () => {
    const raw = { response: '<think>reasoning...</think>{"scene": "A quiet night.", "bibleUpdates": {}}' };
    const parsed = parseStoryOutput(raw);
    expect(parsed?.scene).toBe("A quiet night.");
  });

  test("tolerates stray prose around the JSON object", () => {
    const raw = { response: 'Sure, here is the scene:\n{"scene": "The lights flicker.", "bibleUpdates": {"Alice": "The Skeptic"}}\nHope that helps!' };
    const parsed = parseStoryOutput(raw);
    expect(parsed?.scene).toBe("The lights flicker.");
    expect(parsed?.bibleUpdates).toEqual({ Alice: "The Skeptic" });
  });

  test("falls back to raw text as the scene when the model ignores the JSON format entirely", () => {
    const raw = { response: "Just a plain sentence with no JSON at all." };
    const parsed = parseStoryOutput(raw);
    expect(parsed?.scene).toBe("Just a plain sentence with no JSON at all.");
    expect(parsed?.bibleUpdates).toEqual({});
  });

  test("hard-trims runaway output past the word ceiling", () => {
    const longScene = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const raw = { response: JSON.stringify({ scene: longScene, bibleUpdates: {} }) };
    const parsed = parseStoryOutput(raw);
    expect(parsed?.scene.split(/\s+/).length).toBeLessThan(130);
    expect(parsed?.scene.endsWith("…")).toBe(true);
  });

  test("returns null for empty/unusable output", () => {
    expect(parseStoryOutput({ response: "" })).toBeNull();
    expect(parseStoryOutput({})).toBeNull();
    expect(parseStoryOutput({ response: '{"bibleUpdates": {}}' })).toBeNull(); // no scene field
  });

  test("ignores non-string bibleUpdates entries defensively", () => {
    const raw = { response: JSON.stringify({ scene: "A scene.", bibleUpdates: { Alice: "The Skeptic", Bob: 42 } }) };
    const parsed = parseStoryOutput(raw);
    expect(parsed?.bibleUpdates).toEqual({ Alice: "The Skeptic" });
  });
});

describe("Spec 15: STORYTELLER_FAKE deterministic output", () => {
  test("fake output is seeded by beat+day (same inputs -> same shape) and never touches real facts fields beyond names", () => {
    const view = baseView({ phase: "sunrise", day: 3 });
    const facts = buildStoryFacts(view, "sunrise-hold", nameOf);
    const output = fakeStoryOutput(facts);
    expect(output.scene).toContain("day 3");
    expect(output.scene).toContain("sunrise-hold");
    expect(Object.keys(output.bibleUpdates).length).toBeGreaterThan(0);
  });

  test("fake atmosphere output never mentions a death (nothing to leak — none is in atmosphere facts)", () => {
    const view = baseView({ phase: "sunset", day: 1 });
    const facts = buildStoryFacts(view, "sunset-hold", nameOf);
    const output = fakeStoryOutput(facts);
    expect(output.scene.toLowerCase()).not.toContain("died");
  });
});
