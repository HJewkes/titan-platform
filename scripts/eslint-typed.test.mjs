import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(REPO, "scripts", "fixtures", "eslint-typed");
const ESLINT_BIN = join(dirname(createRequire(import.meta.url).resolve("eslint/package.json")), "bin", "eslint.js");

// --config makes ESLint resolve the config's file globs against the fixture, which mirrors the packages/*/src layout.
function lintFixture(...args) {
  return spawnSync(process.execPath, [ESLINT_BIN, "--config", join(REPO, "eslint.typed.config.js"), ...args], {
    cwd: FIXTURE,
    encoding: "utf8",
  });
}

describe("the type-aware lint config", () => {
  it("reports a narrowing cast, a cast to the same type and a condition that is always true, and nothing else", () => {
    const result = lintFixture("--format", "json", "packages/demo/src/casts.ts");

    expect(result.status).toBe(1);
    const [{ messages }] = JSON.parse(result.stdout);
    expect(messages.map(({ ruleId, line }) => [ruleId, line])).toEqual([
      ["@typescript-eslint/no-unsafe-type-assertion", 2],
      ["@typescript-eslint/no-unnecessary-type-assertion", 6],
      ["@typescript-eslint/no-unnecessary-condition", 10],
    ]);
  }, 60_000);
});
