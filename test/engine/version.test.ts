import { expect, test } from "vitest";
import { ENGINE_VERSION } from "../../src/engine/index";

test("engine exposes a semver version string", () => {
  expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
