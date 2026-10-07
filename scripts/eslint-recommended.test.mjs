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
