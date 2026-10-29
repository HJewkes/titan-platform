import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CI_COVERAGE, planCommands } from "./verify-changed.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const WORKSPACE = [
  { dir: "packages/a/", name: "a", deps: [] },
  { dir: "packages/b/", name: "b", deps: ["a"] },
  { dir: "packages/c/", name: "c", deps: [] },
];

const lintTypesArgs = (changed) =>
  planCommands({ base: "b", changed, workspace: WORKSPACE, hasTimeout: true })
    .find((command) => command.label === "lint:types")?.args;

describe("lint:types scope", () => {
  it("covers a changed package and its workspace dependents, and nothing else", () => {
    // Mutant caught: scoping to the touched dirs without testScope's reverse closure drops dependent b.
    expect(lintTypesArgs(["packages/a/src/x.ts"])).toEqual(["scripts/lint-types.mjs", "--only=packages/a,packages/b"]);
  });

  it("runs unscoped when a lint:types input or a path test-scope does not know changes", () => {
    expect(lintTypesArgs(["packages/c/src/y.ts", "eslint-suppressions.typed.json"])).toEqual(["scripts/lint-types.mjs"]);
    expect(lintTypesArgs(["foo.config.ts"])).toEqual(["scripts/lint-types.mjs"]);
  });

  it("is skipped when no changed path reaches a typed file", () => {
    expect(lintTypesArgs(["site/x.md"])).toBeUndefined();
    expect(lintTypesArgs(["packages/a/README.md", "scripts/x.mjs"])).toBeUndefined();
  });
});

const workflow = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
const ciSteps = Object.entries(workflow.jobs).flatMap(([job, { steps }]) =>
  steps.filter((step) => step.run).map((step) => ({ job, run: step.run.trim() })),
);

const matches = (row, step) => {
  const jobs = [row.job].flat();
  if (!jobs.includes(step.job)) return false;
  if (row.run instanceof RegExp) return row.run.test(step.run);
  return step.run === row.run || step.run.startsWith(`${row.run} `);
};

const labelsOf = (changed) =>
  planCommands({ base: "b", changed, workspace: WORKSPACE, hasTimeout: true }).map((command) => command.label);

describe("CI_COVERAGE mirrors ci.yml", () => {
  it("matches every ci.yml run step to exactly one row and every row to a step", () => {
    // Mutant caught: deleting the pnpm lint row leaves validate's pnpm lint step unmatched.
    const unmatched = ciSteps
      .map((step) => ({ ...step, rows: CI_COVERAGE.filter((row) => matches(row, step)).length }))
      .filter((step) => step.rows !== 1);
    expect(unmatched, "add or fix a CI_COVERAGE row in scripts/verify-changed.mjs").toEqual([]);
    const stale = CI_COVERAGE.filter((row) => !ciSteps.some((step) => matches(row, step)));
    expect(stale).toEqual([]);
    const unexplained = CI_COVERAGE.filter((row) => row.disposition !== "local" && !row.reason);
    expect(unexplained).toEqual([]);
  });

  it("covers the perf job's budget step as ci-only and its build as local", () => {
    const perfSteps = ciSteps.filter((step) => step.job === "perf");
    const dispositionOf = (run) => CI_COVERAGE.find((row) => matches(row, perfSteps.find((step) => step.run === run)))?.disposition;
    expect(dispositionOf("pnpm vitest run --project perf")).toBe("ci-only");
    expect(dispositionOf("pnpm build")).toBe("local");
    expect(dispositionOf("pnpm install --frozen-lockfile")).toBe("setup");
  });

  it("plans every labelled row's command in ci.yml order", () => {
    // Mutant caught: dropping pnpm lint from planCommands, the gap behind two review rounds.
    const ciOrder = [...new Set(ciSteps.map((step) => CI_COVERAGE.find((row) => matches(row, step))?.label))].filter(Boolean);
    expect(labelsOf(["packages/a/src/x.ts"]).filter((label) => ciOrder.includes(label))).toEqual(ciOrder);
  });

  it("runs docs:build, capabilities:check and lint for a change no generator reads", () => {
    // Mutant caught: a path predicate in front of docs:build skips it for a source-only change.
    const labels = labelsOf(["packages/c/src/y.ts"]);
    expect(labels).toEqual(expect.arrayContaining(["docs:build", "capabilities:check", "lint"]));
  });

  it("builds before the checks that read dist", () => {
    const labels = labelsOf(["scripts/x.mjs"]);
    const build = labels.indexOf("build");
    for (const reader of ["max-file-loc", "capabilities:check", "metrics:check", "docs:build"]) {
      expect(labels.indexOf(reader), reader).toBeGreaterThan(build);
    }
    expect(build).toBeGreaterThanOrEqual(0);
  });
});
