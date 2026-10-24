import { describe, expect, it } from "vitest";
import {
  countLoc,
  isLocChecked,
  locRuleFrom,
  locViolations,
  packageDirOf,
  planCommands,
  relatedTestArgs,
  touchedPackageDirs,
  typecheckDirs,
} from "./verify-changed.mjs";

const rule = { max: 3, exclude: new Set(["packages/a/src/big.ts"]) };
const lines = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");

describe("countLoc", () => {
  it("ignores blank and whitespace-only lines", () => {
    // Mutant caught: counting raw lines would flag files CI accepts.
    expect(countLoc("a\n\n  \nb\n")).toBe(2);
  });
});

describe("isLocChecked", () => {
  it("skips test, fixture and out-of-graph files", () => {
    // Mutant caught: dropping the role filter fails every big test file; widening past packages/products diverges from CI.
    expect(isLocChecked("packages/a/src/x.ts")).toBe(true);
    expect(isLocChecked("packages/a/src/x.test.ts")).toBe(false);
    expect(isLocChecked("packages/a/src/fixtures/x.ts")).toBe(false);
    expect(isLocChecked("scripts/x.mjs")).toBe(false);
    expect(isLocChecked("packages/a/README.md")).toBe(false);
  });
});

describe("locRuleFrom", () => {
  it("reads max and excludes from the CI rule", () => {
    // Mutant caught: a hard-coded 350 would ignore the config.
    const config = { rules: [{ id: "other", max: 1 }, { id: "max-file-loc", max: 42, exclude: ["p/x.ts"] }] };
    expect(locRuleFrom(config)).toEqual({ max: 42, exclude: new Set(["p/x.ts"]) });
  });

  it("throws when the rule is missing", () => {
    // Mutant caught: silently passing the gate when the rule is renamed.
    expect(() => locRuleFrom({ rules: [] })).toThrow(/max-file-loc/);
  });
});

describe("locViolations", () => {
  const files = {
    "packages/a/src/over.ts": lines(4),
    "packages/a/src/at.ts": lines(3),
    "packages/a/src/big.ts": lines(9),
    "packages/a/src/over.test.ts": lines(9),
  };
  const read = (path) => files[path] ?? null;

  it("flags only checked, non-excluded files strictly over the max", () => {
    // Mutants caught: >= instead of >, ignoring exclude, ignoring the test-role skip.
    const out = locViolations(Object.keys(files), rule, read);
    expect(out).toEqual([{ path: "packages/a/src/over.ts", loc: 4, max: 3 }]);
  });

  it("treats a missing file as empty", () => {
    // Mutant caught: crashing on a path deleted after the diff.
    expect(locViolations(["packages/a/src/gone.ts"], rule, read)).toEqual([]);
  });
});

describe("package mapping", () => {
  it("maps paths to package dirs and dedupes", () => {
    // Mutants caught: wrong depth for the dir, duplicates, root files counted as packages.
    expect(packageDirOf("packages/a/src/x.ts")).toBe("packages/a");
    expect(packageDirOf("scripts/x.mjs")).toBeNull();
    expect(touchedPackageDirs(["packages/b/x.ts", "packages/a/y.ts", "packages/a/z.ts", "README.md"])).toEqual([
      "packages/a",
      "packages/b",
    ]);
  });

  it("typechecks only packages with type-affecting files and a typecheck script", () => {
    // Mutants caught: tsc for docs-only packages; tsc for packages lacking the script.
    const has = (dir) => dir !== "packages/noscript";
    const changed = ["packages/a/src/x.ts", "packages/docs/README.md", "packages/noscript/src/y.ts", "packages/c/tsconfig.json"];
    expect(typecheckDirs(changed, has)).toEqual(["packages/a", "packages/c"]);
  });
});

describe("relatedTestArgs", () => {
  it("passes source files to vitest related and is null without any", () => {
    // Mutants caught: passing non-source files; running vitest with no files (would run everything).
    expect(relatedTestArgs(["a.md"])).toBeNull();
    expect(relatedTestArgs(["packages/a/x.ts", "a.md"])).toEqual(["related", "--run", "--passWithNoTests", "packages/a/x.ts"]);
  });
});

describe("planCommands", () => {
  const plan = planCommands({ base: "origin/main", changed: ["packages/a/src/x.ts"], hasTypecheckScript: () => true });

  it("orders changeset status, tsc, then bounded vitest", () => {
    // Mutants caught: wrong base ref, missing per-package tsc, reordered steps.
    expect(plan.map((c) => c.label)).toEqual(["changeset status", "tsc packages/a", "vitest related"]);
    expect(plan[0].args).toContain("--since=origin/main");
  });

  it("caps vitest heap and time", () => {
    // Mutants caught: dropping NODE_OPTIONS or the timeout wrapper.
    const vitest = plan.at(-1);
    expect(vitest.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(vitest.cmd).toBe("timeout");
    expect(vitest.args[0]).toBe("600");
  });

  it("omits vitest and tsc for a docs-only change", () => {
    // Mutant caught: running vitest unscoped when nothing is testable.
    const docs = planCommands({ base: "b", changed: ["README.md"], hasTypecheckScript: () => true });
    expect(docs.map((c) => c.label)).toEqual(["changeset status"]);
  });
});
