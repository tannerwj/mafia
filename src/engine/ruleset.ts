import type { RoleId } from "./types";

export type TiePolicy = "runoff-then-peace" | "no-murder" | "random" | "kill-all";
export type DayVoteThreshold = "plurality" | "majority";
export type MafiaConsensus = "unanimous" | "majority" | "designated";
export type RevealOnDeath = "full" | "alignment" | "none";
export type ParityRule = "immediate" | "elimination";

export interface Ruleset {
  roles: Record<RoleId, number | "auto">;
  mafiaCountFormula: "sqrt" | "quarter";
  firstNightKill: boolean;
  tiePolicy: TiePolicy;
  dayVoteThreshold: DayVoteThreshold;
  noMurderOption: boolean;
  mafiaConsensus: MafiaConsensus;
  revealOnDeath: RevealOnDeath;
  parityRule: ParityRule;
  votingVisibility: "hidden" | "realtime";
  // Spec 12 Feature 2: optional narrator-gated reveal beats. When true, a ready
  // night transitions to `sunrise` (UNRESOLVED) and a ready day vote to
  // `sunset` (UNRESOLVED); the host taps `reveal` to run resolution and
  // continue. Default false → the phase sequence is byte-identical to Spec 11.
  scenePhases: boolean;
  timers: { night?: number; day?: number; voting?: number; runoff?: number };
  dawnDuskBeatMs: number;
}

export interface ValidationResult {
  errors: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const HOUSE_RULES: Ruleset = {
  roles: {
    mafia: "auto",
    villager: "auto",
    detective: "auto",
    angel: "auto",
    suicide_bomber: "auto",
    minion: "auto",
  },
  mafiaCountFormula: "sqrt",
  firstNightKill: true,
  tiePolicy: "runoff-then-peace",
  dayVoteThreshold: "plurality",
  noMurderOption: true,
  mafiaConsensus: "unanimous",
  revealOnDeath: "full",
  parityRule: "immediate",
  votingVisibility: "hidden",
  scenePhases: false,
  timers: {},
  dawnDuskBeatMs: 3000,
};

export function autoMafiaCount(playerCount: number, formula: "sqrt" | "quarter"): number {
  return Math.max(1, Math.round(formula === "sqrt" ? Math.sqrt(playerCount) : playerCount / 4));
}

// Spec 13: the scaled recommendation for the house six, confirmed with the
// product owner — do not change these numbers without a new spec. Small
// tables (n < 6) use the explicit cases below (today's fixed defaults are
// invalid there); n >= 6 uses the formula. `villager` is always the
// remainder, resolved by the caller (`materializeRoleCounts`), never here.
export function recommendedRoleCounts(playerCount: number): Record<RoleId, number> {
  const n = Math.max(0, playerCount);
  if (n <= 2) return { mafia: 1, detective: 0, angel: 0, suicide_bomber: 0, minion: 0, villager: Math.max(0, n - 1) };
  if (n === 3) return { mafia: 1, detective: 1, angel: 0, suicide_bomber: 0, minion: 0, villager: 1 };
  if (n === 4) return { mafia: 1, detective: 1, angel: 1, suicide_bomber: 0, minion: 0, villager: 1 };
  if (n === 5) return { mafia: 2, detective: 1, angel: 1, suicide_bomber: 1, minion: 0, villager: 0 };
  const mafia = Math.max(1, Math.max(Math.round(Math.sqrt(n)), Math.round(n / 4)));
  const minion = n >= 16 ? 1 : 0;
  const detective = n >= 16 ? 3 : n >= 8 ? 2 : 1;
  const angel = n >= 12 ? 2 : 1;
  const suicide_bomber = 1;
  const used = mafia + minion + detective + angel + suicide_bomber;
  const villager = Math.max(0, n - used);
  return { mafia, detective, angel, suicide_bomber, minion, villager };
}

export function materializeRoleCounts(ruleset: Ruleset, playerCount: number): Record<RoleId, number> {
  const counts: Record<RoleId, number> = {};
  let used = 0;
  const autoRoles: RoleId[] = [];
  for (const [roleId, count] of Object.entries(ruleset.roles)) {
    if (count === "auto") autoRoles.push(roleId);
    else {
      counts[roleId] = count;
      used += count;
    }
  }
  const recommended = recommendedRoleCounts(playerCount);
  for (const roleId of autoRoles) {
    if (roleId !== "villager") {
      const count = recommended[roleId] ?? 0;
      counts[roleId] = count;
      used += count;
    }
  }
  for (const roleId of autoRoles) {
    if (roleId === "villager") {
      counts[roleId] = Math.max(0, playerCount - used);
      used += counts[roleId]!;
    }
  }
  return counts;
}

export function validateRuleset(ruleset: Ruleset, playerCount: number): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  const warnings: ValidationResult["warnings"] = [];
  const raw = ruleset as unknown;
  if (!isRecord(raw)) {
    return { errors: [{ code: "ruleset_shape_invalid", message: "Ruleset must be an object." }], warnings };
  }

  const rawRoles = raw.roles;
  const rawTimers = raw.timers;
  let canMaterialize = true;
  if (!isRecord(rawRoles)) {
    errors.push({ code: "ruleset_shape_invalid", message: "Ruleset roles must be an object." });
    canMaterialize = false;
  }
  if (!isRecord(rawTimers)) {
    errors.push({ code: "ruleset_shape_invalid", message: "Ruleset timers must be an object." });
    canMaterialize = false;
  }

  const requiredFields: [string, (value: unknown) => boolean][] = [
    ["mafiaCountFormula", (value) => value === "sqrt" || value === "quarter"],
    ["firstNightKill", (value) => typeof value === "boolean"],
    ["tiePolicy", (value) => value === "runoff-then-peace" || value === "no-murder" || value === "random" || value === "kill-all"],
    ["dayVoteThreshold", (value) => value === "plurality" || value === "majority"],
    ["noMurderOption", (value) => typeof value === "boolean"],
    ["mafiaConsensus", (value) => value === "unanimous" || value === "majority" || value === "designated"],
    ["revealOnDeath", (value) => value === "full" || value === "alignment" || value === "none"],
    ["parityRule", (value) => value === "immediate" || value === "elimination"],
    ["votingVisibility", (value) => value === "hidden" || value === "realtime"],
    ["scenePhases", (value) => typeof value === "boolean"],
    ["dawnDuskBeatMs", (value) => typeof value === "number" && Number.isFinite(value)],
  ];
  for (const [name, isValid] of requiredFields) {
    if (!isValid(raw[name])) {
      errors.push({ code: "ruleset_shape_invalid", message: `Ruleset field ${name} is invalid.` });
      canMaterialize = false;
    }
  }

  if (isRecord(rawRoles)) {
    for (const [roleId, count] of Object.entries(rawRoles)) {
      if (
        count !== "auto" &&
        !(typeof count === "number" && Number.isFinite(count) && Number.isInteger(count) && count >= 0)
      ) {
        errors.push({
          code: "role_count_invalid",
          message: `Role count for ${roleId} must be a finite non-negative integer or "auto".`,
        });
        canMaterialize = false;
      }
    }
  }

  if (isRecord(rawTimers)) {
    for (const [name, seconds] of Object.entries(rawTimers)) {
      if (seconds === undefined) continue;
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
        errors.push({ code: "timer_invalid", message: `${name} timer must be a finite number.` });
        canMaterialize = false;
      } else if (seconds < 5) {
        errors.push({ code: "timer_floor", message: `${name} timer must be at least 5 seconds.` });
      }
    }
  }

  if (!canMaterialize) return { errors, warnings };

  const typedRuleset = raw as unknown as Ruleset;
  const counts = materializeRoleCounts(typedRuleset, playerCount);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total !== playerCount) errors.push({ code: "role_count_mismatch", message: "Role counts must equal player count." });
  if ((counts.mafia ?? 0) < 1) errors.push({ code: "mafia_required", message: "At least one mafia role is required." });
  if (typedRuleset.tiePolicy === "runoff-then-peace" && !typedRuleset.noMurderOption) {
    errors.push({ code: "runoff_requires_no_murder", message: "Runoff house policy requires the no-murder option." });
  }
  if (Object.keys(typedRuleset.timers).length === 0) warnings.push({ code: "untimed", message: "All game phases are untimed." });
  return { errors, warnings };
}
