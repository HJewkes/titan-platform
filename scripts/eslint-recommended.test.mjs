import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(REPO, "scripts", "fixtures", "eslint-recommended");
const ESLINT_BIN = join(dirname(createRequire(import.meta.url).resolve("eslint/package.json")), "bin", "eslint.js");
const R9_MESSAGE =
  "`thirtyOneLines` is 31 lines; the limit is 30. Extract one step into a named function in this file. Do not add eslint-disable and do not edit the suppressions file.";

// --config makes ESLint resolve globs against the fixture, so the root config's ignore of this fixture does not apply.
function lintFixture(...args) {
  return spawnSync(process.execPath, [ESLINT_BIN, "--config", join(REPO, "eslint.config.js"), ...args], {
    cwd: FIXTURE,
    encoding: "utf8",
  });
}

describe("the root lint config with the titan recommended rules", () => {
  it("fails a 31-line function with the R9 message", () => {
    const result = lintFixture("--format", "json", "src/thirty-one-lines.ts");

    expect(result.status).toBe(1);
    const [{ messages }] = JSON.parse(result.stdout);
    expect(messages).toEqual([expect.objectContaining({ ruleId: "titan/max-function-lines", message: R9_MESSAGE })]);
  });

  it("passes a 30-line function", () => {
    const result = lintFixture("src/thirty-lines.ts");

    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails when a suppression no longer matches a violation", () => {
    const result = lintFixture("--suppressions-location", "stale-suppressions.json", "src/thirty-lines.ts");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("There are suppressions left that do not occur anymore");
  });
});

describe("the root lint config with the 200-character line cap", () => {
  it("fails a 210-character packed condition in package source", () => {
    const result = lintFixture("--format", "json", "packages/x/src/packed-condition.ts");

    expect(result.status).toBe(1);
    const [{ messages }] = JSON.parse(result.stdout);
    expect(messages).toEqual([
      expect.objectContaining({ ruleId: "titan/max-line-length", line: 2, message: expect.stringContaining("is 210 characters; the limit is 200") }),
    ]);
  });

  it("passes a 250-character table row in a test file", () => {
    const result = lintFixture("packages/x/src/packed-table.test.ts");

    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("the root lint config with the Activity Events API ban", () => {
  const EVENTS_FIXTURE = join(REPO, "scripts", "fixtures", "events-api");

  function lintEventsFixture(file) {
    return spawnSync(process.execPath, [ESLINT_BIN, "--config", join(REPO, "eslint.config.js"), "--format", "json", file], {
      cwd: EVENTS_FIXTURE,
      encoding: "utf8",
    });
  }

  it.each([
    ["a gh api string", "products/factory/src/gh-api-string.ts"],
    ["a gh api template", "products/factory/src/gh-api-template.ts"],
    ["an octokit.request route", "products/factory/src/octokit-request.ts"],
    ["an absolute api URL", "products/factory/src/fetch-url.ts"],
    ["an octokit activity.list call", "products/factory/src/octokit-list.ts"],
  ])("fails %s", (_name, file) => {
    const result = lintEventsFixture(file);

    expect(result.status).toBe(1);
    const [{ messages }] = JSON.parse(result.stdout);
    expect(messages).toEqual([expect.objectContaining({ ruleId: "no-restricted-syntax", message: expect.stringContaining("never an event source") })]);
  });

  it("passes a GraphQL timelineItems query", () => {
    const result = lintEventsFixture("products/factory/src/timeline-items.ts");

    expect(result.stdout).toContain('"errorCount":0');
    expect(result.status).toBe(0);
  });

  it("does not apply outside factory and the github package", () => {
    const result = lintEventsFixture("packages/other/src/gh-api-string.ts");

    expect(result.status).toBe(0);
  });
});
