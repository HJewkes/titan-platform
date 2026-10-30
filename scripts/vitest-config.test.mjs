import { existsSync, globSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import config from "../vitest.config.ts";
import { readWorkspace, testScope, vitestArgs } from "./test-scope.mjs";
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
  // extends: true appends a project's setupFiles to the root's, so active-work's sandbox-home adds and replaces nothing.
  const ACTIVE_WORK_SETUP = ["products/active-work/__tests__/setup/sandbox-home.ts"];
  for (const project of config.test.projects) {
    const expected = project.test.name.startsWith("active-work") ? ACTIVE_WORK_SETUP : undefined;
    expect(project.test.setupFiles, project.test.name).toEqual(expected);
  }
});

// A scoped CI run selects projects by name; one left off the list silently runs none of its tests.
it("names every project in a scoped CI run", () => {
  const scoped = vitestArgs({ mode: "scoped", dirs: [] });
  const named = scoped.flatMap((arg, i) => (scoped[i - 1] === "--project" ? [arg] : []));
  expect(named.sort()).toEqual(config.test.projects.map((project) => project.test.name).sort());
});

// active-work's __tests__ tree sat outside every project's include, so none of its tests ran (TP-4152).
it("runs every active-work __tests__ file in exactly one project", () => {
  const files = globSync("products/active-work/__tests__/**/*.test.ts", { cwd: ROOT });
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) expect(projectsRunning(file), file).toHaveLength(1);
});

const SHARED_GRAPH_PROJECTS = ["factory", "explainer", "console"];
const sharedGraphFiles = () =>
  ["products/factory/src", "products/explainer/src", "apps/console/{src,scripts,server}"].flatMap((dir) => globSync(`${dir}/**/*.test.{ts,tsx}`, { cwd: ROOT }));

it("runs every factory, explainer and console test file in exactly one project", () => {
  const files = sharedGraphFiles();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) expect(projectsRunning(file), file).toHaveLength(1);
});

// Under isolate:false, vi.mock misses a module the worker already loaded, so the test runs against the real one (TP-4441).
it("keeps every file that mocks a module or stubs HOME out of the isolate:false projects", () => {
  const isolating = sharedGraphFiles().filter((file) => /vi\.(mock|doMock)\(|stubEnv\(["']HOME/.test(readFileSync(join(ROOT, file), "utf8")));
  expect(isolating.length).toBeGreaterThan(0);
  for (const file of isolating) expect(projectsRunning(file).filter((name) => SHARED_GRAPH_PROJECTS.includes(name)), file).toEqual([]);
});

// As threads these graphs held the shared vitest process at 3 GB, and Node forks all of it for every git child another
// thread worker spawned: the spawn-heavy files ran up to 2x slower (TP-4526).
it("runs the isolate:false projects in their own capped forks, not in the shared vitest process", () => {
  for (const name of SHARED_GRAPH_PROJECTS) {
    const project = config.test.projects.find((candidate) => candidate.test.name === name);
    expect(project?.test, name).toMatchObject({ pool: "forks", isolate: false, execArgv: [expect.stringMatching(/^--max-old-space-size=/)] });
  }
});

function projectsRunning(file) {
  const matchesAny = (globs) => (globs ?? []).some((glob) => matchesGlob(file, glob));
  return config.test.projects
    .filter((project) => matchesAny(project.test.include) && !matchesAny(project.test.exclude))
    .map((project) => project.test.name);
}

// A second setupFiles key once replaced the first, so the factory setup stopped loading and serve-bot read the real
// home's token path. The resolved config must hold both.
it("loads the factory test setup and the wait budget for every test", () => {
  expect(config.test.setupFiles).toEqual(expect.arrayContaining(["products/factory/src/test-support/vitest-setup.ts", "scripts/vitest-wait-budget.mjs"]));
});

// Every test runs these, so a pull request touching one must run the whole suite, not just scripts/.
it("runs the full suite for a pull request that changes a file every test loads", () => {
  const loadedByEveryTest = [...config.test.globalSetup, ...config.test.setupFiles, "scripts/wait-budget.mjs", "scripts/vitest-file-watchdog.mjs", "scripts/vitest-file-timing.mjs"];
  for (const path of loadedByEveryTest) expect(testScope([path], readWorkspace()), path).toEqual({ mode: "full", reason: path });
});

// Each check waits out a 100 ms interval first, so a thirteenth check means the wait outlived vitest's 1 s default.
it("gives vi.waitFor the budget when a call names no timeout", async () => {
  let checks = 0;
  await vi.waitFor(() => expect((checks += 1)).toBe(13), { interval: 100 });
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
