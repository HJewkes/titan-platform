import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
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

describe("the root lint config with the recipe-file capability ban", () => {
  // The fixture reuses real names from recipe-files.json, because the block's file list is read from that file.
  const RECIPE_FIXTURE = join(REPO, "scripts", "fixtures", "recipe-capabilities");
  const RECIPE_SRC = join("products", "factory", "src");
  const lintRecipeFixture = fixtureLinter(RECIPE_FIXTURE);
  const recipe = (file) => lintRecipeFixture(join(RECIPE_SRC, file));

  it("a recipe file importing node:fs, or a value from the GitHub client, fails no-restricted-imports", async () => {
    const fs = await recipe("audit/workflow.ts");
    const client = await recipe("build-surface/workflow.ts");

    expect(fs.messages).toEqual([expect.objectContaining({ ruleId: "no-restricted-imports", severity: 2 })]);
    expect(client.messages).toEqual([expect.objectContaining({ ruleId: "no-restricted-imports", severity: 2 })]);
  });

  it("a recipe file reading Date.now or calling setTimeout fails no-restricted-globals", async () => {
    const result = await recipe("build-surface/slice-run.ts");

    expect(result.messages.map((message) => [message.ruleId, message.message])).toEqual([
      ["no-restricted-globals", expect.stringContaining("step body")],
      ["no-restricted-globals", expect.stringContaining("step body")],
    ]);
  });

  it("an inline eslint-disable in a recipe file does not suppress the error", async () => {
    const result = await recipe("definition.ts");

    expect(result.messages.filter((message) => message.severity === 2)).toEqual([expect.objectContaining({ ruleId: "no-restricted-globals" })]);
    expect(result.messages).toContainEqual(expect.objectContaining({ ruleId: null, message: expect.stringContaining("noInlineConfig") }));
  });

  it("a type-only import of the GitHub client in a recipe file passes", async () => {
    const result = await recipe("shepherd/approval-carry.ts");

    expect(result.errorCount).toBe(0);
  });

  // A fixture outside the list, or on the baseline, never reaches the block, so its test would pass whatever the block says.
  it("every recipe fixture is a listed recipe file off the baseline", async () => {
    const eslint = new ESLint({ cwd: RECIPE_FIXTURE, overrideConfigFile: CONFIG });
    const fixtures = readdirSync(join(RECIPE_FIXTURE, RECIPE_SRC), { recursive: true }).filter((file) => file.endsWith(".ts"));
    const configs = await Promise.all(fixtures.map((file) => eslint.calculateConfigForFile(join(RECIPE_FIXTURE, RECIPE_SRC, file))));

    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.filter((_, index) => !configs[index]?.rules?.["no-restricted-globals"])).toEqual([]);
  });

  it("the Events API ban still applies to a recipe file", async () => {
    const result = await recipe("shepherd/account-hold.ts");

    expect(result.messages).toEqual([expect.objectContaining({ ruleId: "no-restricted-syntax", severity: 2, message: expect.stringContaining("never an event source") })]);
  });
});
