import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as graph from "../packages/code-graph/dist/index.js";
import {
  countLoc,
  isLocChecked,
  locRuleFrom,
  locViolations,
  packageDirOf,
  planCommands,
  relatedTestArgs,
  roleClassifier,
  touchedPackageDirs,
  typecheckDirs,
} from "./verify-changed.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const roleOf = roleClassifier(graph, ROOT);
const rule = { max: 3, exclude: new Set(["packages/a/src/big.ts"]), excludeRoles: new Set(["test", "fixture"]) };
const lines = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");

describe("countLoc", () => {
  it("ignores blank and whitespace-only lines", () => {
    // Mutant caught: counting raw lines would flag files CI accepts.
    expect(countLoc("a\n\n  \nb\n")).toBe(2);
  });
});

describe("isLocChecked", () => {
  const checked = (path) => isLocChecked(path, rule, roleOf);

  it("checks source under every root the CI graph indexes", () => {
    // Mutant caught: dropping apps/ passes a 351-line apps/console file that dag-check fails.
    expect(checked("packages/a/src/x.ts")).toBe(true);
    expect(checked("products/a/src/x.ts")).toBe(true);
    expect(checked("apps/console/server/rounds.ts")).toBe(true);
    expect(checked("scripts/x.mjs")).toBe(false);
    expect(checked("packages/a/README.md")).toBe(false);
  });

  it("exempts exactly the files code-graph classifies as test or fixture", () => {
    // Mutants caught: a hand-rolled regex that misses *.fixture.ts and test/ dirs, or exempts *.test-helpers.ts and fixture/.
    expect(checked("packages/a/src/x.test.ts")).toBe(false);
    expect(checked("packages/a/src/fixtures/x.ts")).toBe(false);
    expect(checked("packages/code-graph/src/analysis/test-kinds.fixture.ts")).toBe(false);
    expect(checked("packages/a/test/big.ts")).toBe(false);
    expect(checked("packages/a/src/__tests__/big.ts")).toBe(false);
    expect(checked("products/factory/src/shepherd/gate-resolve-closure.test-helpers.ts")).toBe(true);
    expect(checked("packages/a/src/fixture/x.ts")).toBe(true);
  });

  it("follows the rule's excludeRoles rather than a fixed list", () => {
    // Mutant caught: ignoring excludeRoles and always exempting tests.
    const strict = { ...rule, excludeRoles: new Set() };
    expect(isLocChecked("packages/a/src/x.test.ts", strict, roleOf)).toBe(true);
  });
});

describe("roleClassifier", () => {
  it("refuses a repo with configured role globs it cannot apply", () => {
    // Mutant caught: silently ignoring roles.json, so a glob-assigned fixture would fail the gate CI passes.
    const configured = { ...graph, loadRoleGlobs: () => ({ fixture: ["lab/**"] }) };
    expect(() => roleClassifier(configured, ROOT)).toThrow(/roles\.json/);
  });
});

describe("locRuleFrom", () => {
  it("reads max and excludes from the CI rule", () => {
    // Mutant caught: a hard-coded 350 would ignore the config.
    const config = { rules: [{ id: "other", max: 1 }, { id: "max-file-loc", max: 42, exclude: ["p/x.ts"], excludeRoles: ["test"] }] };
    expect(locRuleFrom(config)).toEqual({ max: 42, exclude: new Set(["p/x.ts"]), excludeRoles: new Set(["test"]) });
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
    "apps/console/server/over.ts": lines(4),
  };
  const read = (path) => files[path] ?? null;

  it("flags only checked, non-excluded files strictly over the max", () => {
    // Mutants caught: >= instead of >, ignoring exclude, ignoring the test-role skip.
    const out = locViolations(Object.keys(files), rule, read, roleOf);
    expect(out).toEqual([
      { path: "packages/a/src/over.ts", loc: 4, max: 3 },
      { path: "apps/console/server/over.ts", loc: 4, max: 3 },
    ]);
  });

  it("treats a missing file as empty", () => {
    // Mutant caught: crashing on a path deleted after the diff.
    expect(locViolations(["packages/a/src/gone.ts"], rule, read, roleOf)).toEqual([]);
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
  const plan = planCommands({ base: "origin/main", changed: ["packages/a/src/x.ts"], hasTypecheckScript: () => true, hasTimeout: true });

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

  it("still runs vitest, unbounded and labelled so, without a timeout command", () => {
    // Mutant caught: spawning a missing timeout binary, which fails the gate on stock macOS.
    const bare = planCommands({ base: "b", changed: ["packages/a/src/x.ts"], hasTypecheckScript: () => true, hasTimeout: false });
    const vitest = bare.at(-1);
    expect(vitest.cmd).toBe("pnpm");
    expect(vitest.args.slice(0, 3)).toEqual(["exec", "vitest", "related"]);
    expect(vitest.label).toMatch(/no timeout/);
  });

  it("omits vitest and tsc for a docs-only change", () => {
    // Mutant caught: running vitest unscoped when nothing is testable.
    const docs = planCommands({ base: "b", changed: ["README.md"], hasTypecheckScript: () => true });
    expect(docs.map((c) => c.label)).toEqual(["changeset status"]);
  });
});
