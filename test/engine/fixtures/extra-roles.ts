import { HOUSE_ROLE_DEFS, type RoleDef, type RoleRegistry } from "../../../src/engine";

export const GODFATHER: RoleDef = {
  id: "godfather",
  displayName: "Godfather",
  alignment: "mafia",
  countsForParityAs: "mafia",
  knowledgeAtStart: "mafia-partners",
  nightAction: { actionType: "mafiaKill", priorityBand: 400, targetRule: "living-other", consensus: "mafia" },
  passives: { investigationImmune: true },
  attackTier: "basic",
};

export const JESTER: RoleDef = {
  id: "jester",
  displayName: "Jester",
  alignment: "neutral",
  countsForParityAs: "village",
  winHook: (_state, event) => event.type === "playerDied" && event.cause === "vote" && event.roleId === "jester" ? ["jester"] : null,
};

export const ESCORT: RoleDef = {
  id: "escort",
  displayName: "Escort",
  alignment: "town",
  countsForParityAs: "village",
  nightAction: { actionType: "roleblock", priorityBand: 200, targetRule: "living-other" },
};

export const FIXTURE_ROLES: RoleRegistry = {
  ...HOUSE_ROLE_DEFS,
  godfather: GODFATHER,
  jester: JESTER,
  escort: ESCORT,
};
