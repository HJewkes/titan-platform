import { expect, it } from "vitest";
import config from "../vitest.config.ts";

const VITEST_DEFAULT_TIMEOUT_MS = 5_000;

// On a loaded 4-vCPU runner, tests that take 0.3 s idle reached 5.2 s and died on vitest's 5 s default (TP-3977).
it("gives every project a test timeout sized for a loaded runner, not vitest's 5 s default", () => {
  expect(config.test.testTimeout ?? VITEST_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  for (const project of config.test.projects) {
    expect(project.extends, project.test.name).toBe(true);
    expect(project.test.testTimeout, project.test.name).toBeUndefined();
  }
});
