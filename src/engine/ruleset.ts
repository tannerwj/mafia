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

export const HOUSE_RULES: Ruleset = {
  roles: {
    mafia: "auto",
    villager: "auto",
    detective: 1,
    angel: 1,
    suicide_bomber: 1,
    minion: 0,
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
  for (const roleId of autoRoles) {
    if (roleId === "mafia") {
      const count = autoMafiaCount(playerCount, ruleset.mafiaCountFormula);
      counts[roleId] = count;
      used += count;
    }
  }
  for (const roleId of autoRoles) {
    if (roleId !== "mafia") {
      counts[roleId] = Math.max(0, playerCount - used);
      used += counts[roleId]!;
    }
  }
  return counts;
}

export function validateRuleset(ruleset: Ruleset, playerCount: number): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  const warnings: ValidationResult["warnings"] = [];
  const counts = materializeRoleCounts(ruleset, playerCount);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total !== playerCount) errors.push({ code: "role_count_mismatch", message: "Role counts must equal player count." });
  if ((counts.mafia ?? 0) < 1) errors.push({ code: "mafia_required", message: "At least one mafia role is required." });
  if (ruleset.tiePolicy === "runoff-then-peace" && !ruleset.noMurderOption) {
    errors.push({ code: "runoff_requires_no_murder", message: "Runoff house policy requires the no-murder option." });
  }
  for (const [name, seconds] of Object.entries(ruleset.timers)) {
    if (seconds !== undefined && seconds < 5) errors.push({ code: "timer_floor", message: `${name} timer must be at least 5 seconds.` });
  }
  if (Object.keys(ruleset.timers).length === 0) warnings.push({ code: "untimed", message: "All game phases are untimed." });
  return { errors, warnings };
}
