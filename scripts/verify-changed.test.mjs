import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as graph from "../packages/code-graph/dist/index.js";
import { entryPointOf, exportSources } from "./gen-capabilities.mjs";
import { MARKED_PAGES, collect } from "./gen-docs-reference.mjs";
import {
  countLoc,
  docsTriggers,
  generatorTriggers,
  importClosure,
  locRuleFrom,
  locScope,
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
const rule = { max: 3, exclude: ["packages/a/src/big.ts"], excludeRoles: new Set(["test", "fixture"]) };
const inScope = locScope(graph, rule, roleOf);
const triggers = generatorTriggers(ROOT);
const lines = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");

describe("countLoc", () => {
  it("ignores blank and whitespace-only lines", () => {
    // Mutant caught: counting raw lines would flag files CI accepts.
    expect(countLoc("a\n\n  \nb\n")).toBe(2);
  });
});

describe("locScope", () => {
  const checked = inScope;

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

  it("skips files code-graph never indexes: declarations, JS and excluded directories", () => {
    // Mutant caught: an own extension regex that counts the committed api/*.d.ts reports CI never sees.
    expect(checked("packages/a/api/index.d.ts")).toBe(false);
    expect(checked("packages/a/src/x.js")).toBe(false);
    expect(checked("packages/a/vendor/x.ts")).toBe(false);
    expect(checked("packages/a/src/x.tsx")).toBe(true);
  });

  it("matches excludes with code-graph's pattern semantics, globs included", () => {
    // Mutant caught: exact-path Set lookup, which ignores a glob entry CI honours.
    const globbed = locScope(graph, { ...rule, exclude: ["packages/a/src/gen/*"] }, roleOf);
    expect(globbed("packages/a/src/gen/big.ts")).toBe(false);
    expect(globbed("packages/a/src/big.ts")).toBe(true);
    expect(checked("packages/a/src/big.ts")).toBe(false);
  });

  it("follows the rule's excludeRoles rather than a fixed list", () => {
    // Mutant caught: ignoring excludeRoles and always exempting tests.
    const strict = locScope(graph, { ...rule, excludeRoles: new Set() }, roleOf);
    expect(strict("packages/a/src/x.test.ts")).toBe(true);
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
    expect(locRuleFrom(config)).toEqual({ max: 42, exclude: ["p/x.ts"], excludeRoles: new Set(["test"]) });
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
    "packages/a/api/index.d.ts": lines(9),
  };
  const read = (path) => files[path] ?? null;

  it("flags only checked, non-excluded files strictly over the max", () => {
    // Mutants caught: >= instead of >, ignoring exclude, ignoring the test-role skip, counting a .d.ts report.
    const out = locViolations(Object.keys(files), rule, read, inScope);
    expect(out).toEqual([
      { path: "packages/a/src/over.ts", loc: 4, max: 3 },
      { path: "apps/console/server/over.ts", loc: 4, max: 3 },
    ]);
  });

  it("treats a missing file as empty", () => {
    // Mutant caught: crashing on a path deleted after the diff.
    expect(locViolations(["packages/a/src/gone.ts"], rule, read, inScope)).toEqual([]);
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
  const plan = planCommands({ base: "origin/main", changed: ["packages/a/src/x.ts"], hasTypecheckScript: () => true, hasTimeout: true, triggers });

  it("orders changeset status, tsc, then bounded vitest", () => {
    // Mutants caught: wrong base ref, missing per-package tsc or lint:types, reordered steps.
    expect(plan.map((c) => c.label)).toEqual(["changeset status", "tsc packages/a", "lint:types", "build changed packages", "capabilities:check", "vitest related"]);
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
    const bare = planCommands({ base: "b", changed: ["packages/a/src/x.ts"], hasTypecheckScript: () => true, hasTimeout: false, triggers });
    const vitest = bare.at(-1);
    expect(vitest.cmd).toBe("pnpm");
    expect(vitest.args.slice(0, 3)).toEqual(["exec", "vitest", "related"]);
    expect(vitest.label).toMatch(/no timeout/);
  });

  it("omits vitest and tsc for a docs-only change", () => {
    // Mutant caught: running vitest unscoped when nothing is testable.
    const docs = planCommands({ base: "b", changed: ["packages/a/README.md"], hasTypecheckScript: () => true, triggers });
    expect(docs.map((c) => c.label)).toEqual(["changeset status"]);
  });
});

describe("lint:types scope", () => {
  const plan = (changed) => planCommands({ base: "b", changed, hasTypecheckScript: () => true, hasTimeout: true, triggers });

  it("lints only the changed packages", () => {
    // Mutant caught: dropping --only so every package is linted (minutes, not seconds) on a one-package change.
    const lint = plan(["packages/a/src/x.ts", "packages/b/tsconfig.json", "packages/c/README.md"]).find((c) => c.label === "lint:types");
    expect(lint.args).toEqual(["scripts/lint-types.mjs", "--only=packages/a,packages/b"]);
  });

  it("skips lint:types when no type-affecting file changed", () => {
    // Mutant caught: running type-aware lint for a docs-only change.
    expect(plan(["packages/a/README.md"]).map((c) => c.label)).not.toContain("lint:types");
  });
});

describe("docs gate", () => {
  const plan = (changed) => planCommands({ base: "b", changed, hasTypecheckScript: () => false, hasTimeout: true, triggers }).map((c) => c.label);

  it("skips both checks when neither a docs nor a package input changed", () => {
    // Mutant caught: always appending docs:build or capabilities:check, which adds minutes to every push.
    expect(plan(["scripts/verify-changed.mjs"])).toEqual(expect.not.arrayContaining(["docs:build", "capabilities:check"]));
  });

  it("checks capabilities, after rebuilding the package, when any public package source changed", () => {
    // Mutant caught: triggering on src/index.ts only, so a signature change in src/foo.ts fails CI on a stale api snapshot.
    const labels = plan(["packages/a/src/foo.ts"]);
    expect(labels).toEqual(expect.arrayContaining(["build changed packages", "capabilities:check"]));
    expect(labels.indexOf("build changed packages")).toBeLessThan(labels.indexOf("capabilities:check"));
    expect(labels).not.toContain("docs:build");
  });

  it("checks capabilities for a product's star-exported source without rebuilding it", () => {
    // Mutant caught: matching packages/ only, so a product export change fails CI's capabilities:check.
    const labels = plan(["products/explainer/src/render-exports.ts"]);
    expect(labels).toContain("capabilities:check");
    expect(labels).not.toContain("build changed packages");
  });

  it("runs docs:build for a docs or generator input", () => {
    // Mutant caught: leaving a generator input out of the set, so stale generated docs reach CI.
    for (const input of ["site/guides/x.md", "README.md", "scripts/api-snapshots.mjs", "scripts/new-package.mjs", "packages/a/package.json"]) {
      expect(plan([input]), input).toEqual(expect.arrayContaining(["docs:build", "capabilities:check"]));
    }
  });

  it("leaves files no generator reads alone", () => {
    // Mutant caught: an unanchored pattern matching any package.json, CAPABILITY.md or src/ path.
    for (const miss of ["scripts/verify-changed.mjs", "packages/a/README.md", "templates/package/package.json", "packages/a/test/x.test.ts", "docs/packages/a/src/x.ts"]) {
      expect(triggers.capabilities(miss), miss).toBe(false);
    }
  });
});

describe("docs triggers derived from the generators", () => {
  it("cover every page the reference generator fills", () => {
    // Mutant caught: a hand-written list that drops a MARKED_PAGES page such as README.md.
    for (const page of Object.keys(MARKED_PAGES)) expect(triggers.docs(page), page).toBe(true);
  });

  it("cover every file the export walk reads, in every unit group", () => {
    // Mutant caught: triggering on packages/ only, or on src/index.ts only, missing `export *` targets.
    const walked = collect(ROOT)
      .filter((entry) => entry.group)
      .flatMap((entry) => exportSources(entryPointOf(ROOT, entry)).map((file) => relative(ROOT, file)));
    expect(walked.some((file) => file.startsWith("products/") && !file.endsWith("index.ts"))).toBe(true);
    expect(walked.filter((file) => !triggers.capabilities(file))).toEqual([]);
  });

  it("cover the generators and every module they import", () => {
    // Mutant caught: a generator gains an import that the trigger never learns about.
    const sources = { "scripts/a.mjs": 'import { x } from "./b.mjs";', "scripts/b.mjs": 'export * from "../lib/c.mjs";', "lib/c.mjs": "" };
    expect(importClosure(["scripts/a.mjs"], (path) => sources[path]).sort()).toEqual(["lib/c.mjs", "scripts/a.mjs", "scripts/b.mjs"]);
    const own = docsTriggers({ markedPages: {}, unitGroups: ["packages"], generatorModules: ["lib/c.mjs"] });
    expect(own.docs("lib/c.mjs")).toBe(true);
    expect(own.docs("products/a/package.json")).toBe(false);
  });
});
