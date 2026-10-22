import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import config from "../vitest.config.ts";
import { WAIT_BUDGET_MS } from "./wait-budget.mjs";

const VITEST_DEFAULT_TIMEOUT_MS = 5_000;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TESTING_LIBRARY_DOM = "@testing-library/dom/package.json";

// On a loaded 4-vCPU runner, tests that take 0.3 s idle reached 5.2 s and died on vitest's 5 s default (TP-3977).
it("gives every project a test timeout sized for a loaded runner, not vitest's 5 s default", () => {
  expect(config.test.testTimeout ?? VITEST_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  for (const project of config.test.projects) {
    expect(project.extends, project.test.name).toBe(true);
    expect(project.test.testTimeout, project.test.name).toBeUndefined();
  }
});

// The same runners stretched a findBy past testing-library's 1 s default and froze main (TP-3983).
it("sizes in-test waits for a loaded runner and keeps them under the test timeout", () => {
  expect(WAIT_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
  expect(WAIT_BUDGET_MS).toBeLessThan(config.test.testTimeout);
  expect(config.test.expect.poll.timeout).toBe(WAIT_BUDGET_MS);
  expect(config.test.setupFiles).toContain("scripts/vitest-wait-budget.mjs");
  for (const project of config.test.projects) expect(project.test.setupFiles, project.test.name).toBeUndefined();
});

it("gives vi.waitFor the budget when a call names no timeout", async () => {
  const start = Date.now();
  await vi.waitFor(() => expect(Date.now() - start).toBeGreaterThan(1_200), { interval: 100 });
});

function domTestPackages() {
  return ["apps", "packages", "products"].flatMap((tier) =>
    readdirSync(join(ROOT, tier), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, tier, entry.name, "package.json")))
      .map((entry) => join(ROOT, tier, entry.name))
      .filter((dir) => readFileSync(join(dir, "package.json"), "utf8").includes('"@testing-library/')),
  );
}

// The setup file configures one copy of testing-library; a package resolving another copy would keep the 1 s default.
it("resolves every DOM-testing package's testing-library to the copy the setup file configures", () => {
  const configured = realpathSync(createRequire(join(ROOT, "package.json")).resolve(TESTING_LIBRARY_DOM));
  const packages = domTestPackages();
  expect(packages.length).toBeGreaterThan(0);
  for (const dir of packages) {
    const fromReact = createRequire(createRequire(join(dir, "package.json")).resolve("@testing-library/react"));
    expect(realpathSync(fromReact.resolve(TESTING_LIBRARY_DOM)), dir).toBe(configured);
  }
});
