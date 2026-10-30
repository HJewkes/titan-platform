import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as graph from "../packages/code-graph/dist/index.js";
import {
  countLoc,
  describeOutcome,
  locRuleFrom,
  locScope,
  locViolations,
  planCommands,
  relatedTestArgs,
  roleClassifier,
} from "./verify-changed.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const roleOf = roleClassifier(graph, ROOT);
const rule = { max: 3, exclude: ["packages/a/src/big.ts"], excludeRoles: new Set(["test", "fixture"]) };
const inScope = locScope(graph, rule, roleOf);
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

describe("relatedTestArgs", () => {
  it("passes source files to vitest related and is null without any", () => {
    // Mutants caught: passing non-source files; running vitest with no files (would run everything).
    expect(relatedTestArgs(["a.md"])).toBeNull();
    expect(relatedTestArgs(["packages/a/x.ts", "a.md"])).toEqual(["related", "--run", "--passWithNoTests", "packages/a/x.ts"]);
  });
});

describe("planCommands", () => {
  const workspace = [{ dir: "packages/a/", name: "a", deps: [] }];
  const plan = planCommands({ base: "origin/main", changed: ["packages/a/src/x.ts"], workspace, hasTimeout: true });
  const vitestOf = (commands) => commands.find((c) => c.label.startsWith("vitest related"));

  it("checks changesets and the INDEX_VERSION bump against the base", () => {
    // Mutants caught: wrong base ref for either guard.
    expect(plan.find((c) => c.label === "changeset status").args).toContain("--since=origin/main");
    expect(plan.find((c) => c.label === "index-version:check").env).toEqual({ BASE_REF: "origin/main" });
  });

  it("caps vitest heap and time", () => {
    // Mutants caught: dropping NODE_OPTIONS or the timeout wrapper.
    const vitest = vitestOf(plan);
    expect(vitest.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(vitest.cmd).toBe("timeout");
    expect(vitest.args[0]).toBe("600");
  });

  it("defers the full suite to CI when a root config file changed", () => {
    // Mutant caught: running the full suite locally under the 600 s cap, which times out with no test failing.
    const root = planCommands({ base: "origin/main", changed: ["vitest.config.ts"], workspace, hasTimeout: true });
    const vitest = vitestOf(root);
    expect(vitest).toEqual({ label: "vitest related: full suite selected, deferred to CI", deferred: true });
  });

  it("reports a vitest cap kill as a timeout and any other nonzero exit as a failure", () => {
    // Mutant caught: reporting exit 124 with zero failed tests as "failed".
    const step = vitestOf(plan);
    expect(describeOutcome(step, 0)).toEqual({ ok: true });
    expect(describeOutcome(step, 124).message).toMatch(/timed out after 600 s.*no test failed/);
    expect(describeOutcome(step, 1).message).toBe(`${step.label} failed`);
  });

  it("still runs vitest, unbounded and labelled so, without a timeout command", () => {
    // Mutant caught: spawning a missing timeout binary, which fails the gate on stock macOS.
    const bare = planCommands({ base: "b", changed: ["packages/a/src/x.ts"], workspace, hasTimeout: false });
    const vitest = vitestOf(bare);
    expect(vitest.cmd).toBe("pnpm");
    expect(vitest.args.slice(0, 3)).toEqual(["exec", "vitest", "related"]);
    expect(vitest.label).toMatch(/no timeout/);
  });

  it("spools a verify-changed timing record from the vitest run", () => {
    const plan = planCommands({ base: "b", changed: ["packages/a/src/x.ts"], workspace, spool: "/spool" });
    const vitest = plan.find((c) => c.label.startsWith("vitest"));
    expect(vitest.env).toMatchObject({ TITAN_TEST_TIMING_SPOOL: "/spool", TITAN_TEST_TIMING_RUNNER: "verify-changed" });
  });

  it("omits vitest and lint:types for a docs-only change", () => {
    // Mutant caught: running vitest unscoped when nothing is testable.
    const labels = planCommands({ base: "b", changed: ["README.md"], workspace }).map((c) => c.label);
    expect(labels).not.toContain("lint:types");
    expect(labels.some((label) => label.startsWith("vitest"))).toBe(false);
  });

  it("plans nothing when nothing changed", () => {
    expect(planCommands({ base: "b", changed: [], workspace })).toEqual([]);
  });
});
