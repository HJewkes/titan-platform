import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = join(REPO, "eslint.config.js");
const FIXTURE = join(REPO, "scripts", "fixtures", "eslint-recommended");
const ESLINT_BIN = join(dirname(createRequire(import.meta.url).resolve("eslint/package.json")), "bin", "eslint.js");
const R9_MESSAGE =
  "`thirtyOneLines` is 31 lines; the limit is 30. Extract one step into a named function in this file. Do not add eslint-disable and do not edit the suppressions file.";

// One in-process ESLint per fixture, as the CLI's --config would run it: globs resolve against the fixture, so the
// root config's ignore of the fixtures does not apply.
function fixtureLinter(fixture) {
  const eslint = new ESLint({ cwd: fixture, overrideConfigFile: CONFIG });
  return async (file) => {
    const [result] = await eslint.lintFiles([file]);
    return result;
  };
}

const lintFixture = fixtureLinter(FIXTURE);

describe("the root lint config with the titan recommended rules", () => {
  it("fails a 31-line function with the R9 message", async () => {
    const result = await lintFixture("src/thirty-one-lines.ts");

    expect(result.messages).toEqual([expect.objectContaining({ ruleId: "titan/max-function-lines", message: R9_MESSAGE, severity: 2 })]);
  });

  it("passes a 30-line function", async () => {
    const result = await lintFixture("src/thirty-lines.ts");

    expect(result.messages).toEqual([]);
  });

  // Suppressions are a CLI feature with no ESLint-class option, so this case stays a spawned CLI run.
  it("fails when a suppression no longer matches a violation", () => {
    const result = spawnSync(
      process.execPath,
      [ESLINT_BIN, "--config", CONFIG, "--suppressions-location", "stale-suppressions.json", "src/thirty-lines.ts"],
      { cwd: FIXTURE, encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("There are suppressions left that do not occur anymore");
  });
});

describe("the root lint config with the 200-character line cap", () => {
  it("fails a 210-character packed condition in package source", async () => {
    const result = await lintFixture("packages/x/src/packed-condition.ts");

    expect(result.messages).toEqual([
      expect.objectContaining({ ruleId: "titan/max-line-length", line: 2, severity: 2, message: expect.stringContaining("is 210 characters; the limit is 200") }),
    ]);
  });

  it("passes a 250-character table row in a test file", async () => {
    const result = await lintFixture("packages/x/src/packed-table.test.ts");

    expect(result.messages).toEqual([]);
  });
});

describe("the root lint config with the Activity Events API ban", () => {
  const lintEventsFixture = fixtureLinter(join(REPO, "scripts", "fixtures", "events-api"));

  it.each([
    ["a gh api string", "products/factory/src/gh-api-string.ts"],
    ["a gh api template", "products/factory/src/gh-api-template.ts"],
    ["an octokit.request route", "products/factory/src/octokit-request.ts"],
    ["an absolute api URL", "products/factory/src/fetch-url.ts"],
    ["an octokit activity.list call", "products/factory/src/octokit-list.ts"],
  ])("fails %s", async (_name, file) => {
    const result = await lintEventsFixture(file);

    expect(result.messages).toEqual([
      expect.objectContaining({ ruleId: "no-restricted-syntax", severity: 2, message: expect.stringContaining("never an event source") }),
    ]);
  });

  it("passes a GraphQL timelineItems query", async () => {
    const result = await lintEventsFixture("products/factory/src/timeline-items.ts");

    expect(result.errorCount).toBe(0);
  });

  it("does not apply outside factory and the github package", async () => {
    const result = await lintEventsFixture("packages/other/src/gh-api-string.ts");

    expect(result.errorCount).toBe(0);
  });
});

describe("the root lint config with the wall-clock motion ban", () => {
  const lintClockFixture = fixtureLinter(join(REPO, "scripts", "fixtures", "wall-clock"));

  it("fails a Date.now() in explainer beat code", async () => {
    const result = await lintClockFixture("products/explainer/src/beat-clock.ts");

    expect(result.messages).toEqual([expect.objectContaining({ ruleId: "titan/no-wall-clock-motion", severity: 2, message: expect.stringContaining("`Date.now`") })]);
  });

  it("fails a Date.now() in the explainer composition page", async () => {
    const result = await lintClockFixture("products/explainer/src/composition/page-clock.ts");

    expect(result.messages).toEqual([expect.objectContaining({ ruleId: "titan/no-wall-clock-motion", severity: 2, message: expect.stringContaining("`Date.now`") })]);
  });

  it("passes a Date.now() in explainer code outside the beat and motion paths", async () => {
    const result = await lintClockFixture("products/explainer/src/report-clock.ts");

    expect(result.errorCount).toBe(0);
  });
});

describe("the root lint config with the bare gray-matter import ban", () => {
  const lintMatterFixture = fixtureLinter(join(REPO, "scripts", "fixtures", "gray-matter"));

  it("fails a bare gray-matter import in active-work source", async () => {
    const result = await lintMatterFixture("products/active-work/src/bare-import.ts");

    expect(result.messages).toEqual([expect.objectContaining({ ruleId: "no-restricted-imports", severity: 2, message: expect.stringContaining("gray-matter-io.ts") })]);
  });

  it("passes the gray-matter wrapper itself", async () => {
    const result = await lintMatterFixture("products/active-work/src/utils/gray-matter-io.ts");

    expect(result.errorCount).toBe(0);
  });

  it("does not apply outside active-work", async () => {
    const result = await lintMatterFixture("products/other/src/bare-import.ts");

    expect(result.errorCount).toBe(0);
  });
});
