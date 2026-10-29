import { describe, expect, it } from "vitest";
import { planCommands } from "./verify-changed.mjs";

const WORKSPACE = [
  { dir: "packages/a/", name: "a", deps: [] },
  { dir: "packages/b/", name: "b", deps: ["a"] },
  { dir: "packages/c/", name: "c", deps: [] },
];

const lintTypesArgs = (changed) =>
  planCommands({ base: "b", changed, workspace: WORKSPACE, hasTypecheckScript: () => true, hasTimeout: true })
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
