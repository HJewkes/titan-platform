import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TYPED_FILES } from "../eslint.typed.config.js";
import { baselineFinder, chunkExit, chunkGroups, groupsInPackages, lintGroups, lintUnits, rootBaselineRefusal, runEslint, runUnits, TYPED_BASELINE, UNTYPED_BASELINE } from "./lint-units.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const groupsOfSize = (...sizes) => sizes.map((files, i) => ({ pattern: `g${i}`, dir: `d${i}`, pkg: `pkg/${i}`, files }));
const unitsOfSize = (...sizes) => groupsOfSize(...sizes).map((group) => ({ groups: [group], patterns: [group.pattern], files: group.files }));

const roots = [];
function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), "lint-units-"));
  roots.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "{}");
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("lint chunking", () => {
  it("lints every typed file in the repo exactly once across all units", () => {
    const units = lintUnits(lintGroups(REPO, TYPED_FILES), baselineFinder(REPO, TYPED_BASELINE, []), 600);

    const linted = units.flatMap((unit) => globSync(unit.patterns, { cwd: REPO }));

    expect(new Set(linted).size).toBe(linted.length);
    expect(new Set(linted)).toEqual(new Set(globSync(TYPED_FILES, { cwd: REPO })));
  });

  it("puts a group larger than the cap in a chunk of its own and packs the rest greedily", () => {
    const chunks = chunkGroups(groupsOfSize(700, 100, 450, 200), 600);

    expect(chunks.map((chunk) => chunk.map((group) => group.files))).toEqual([[700], [100, 450], [200]]);
  });

  it("keeps a target outside every workspace glob verbatim under its package, or the root", () => {
    const root = repoWith(["apps/web/src/a.ts", "scripts/a.mjs"]);

    const groups = lintGroups(root, ["apps/web/src", "scripts"]);

    expect(groups.map(({ pattern, pkg }) => [pattern, pkg])).toEqual([["apps/web/src", "apps/web"], ["scripts", "."]]);
  });

  it("drops a package a workspace glob matches nothing in, so eslint never fails on an empty pattern", () => {
    const root = repoWith(["packages/a/scripts/x.ts", "packages/b/src/y.ts"]);

    expect(lintGroups(root, ["packages/*/scripts/**/*.ts"]).map((group) => group.pkg)).toEqual(["packages/a"]);
  });
});

describe("lint units and baselines", () => {
  const ROOT_FILES = ["packages/a/src/x.ts", "packages/a/scripts/x.ts", "packages/b/src/x.ts", "packages/c/src/x.ts"];
  const groupsIn = (root) => lintGroups(root, ["packages/*/src/**/*.ts", "packages/*/scripts/**/*.ts"]);

  it("gives a package with a baseline its own process holding all its globs, and shares one among the rest", () => {
    const root = repoWith([...ROOT_FILES, `packages/a/${TYPED_BASELINE}`]);

    const units = lintUnits(groupsIn(root), baselineFinder(root, TYPED_BASELINE, []), 600);

    expect(units.map((unit) => [unit.baseline, unit.patterns])).toEqual([
      [`packages/a/${TYPED_BASELINE}`, ["packages/a/src/**/*.ts", "packages/a/scripts/**/*.ts"]],
      [undefined, ["packages/b/src/**/*.ts", "packages/c/src/**/*.ts"]],
    ]);
  });

  const argsOf = async (root, unit, options) => {
    let args;
    await runEslint(root, unit, { before: ["--flag"], options }, async (_, passed) => {
      args = passed;
      return { status: 0, signal: null };
    });
    return args;
  };

  it("gives a shared unit no suppressions flag, since eslint fails on a named file that is missing", async () => {
    const args = await argsOf(repoWith([]), { patterns: ["p"] }, []);

    expect(args).toEqual(["--flag", "p"]);
  });

  it("never prunes a shared unit, where eslint would write a root baseline", async () => {
    const args = await argsOf(repoWith([]), { patterns: ["p"] }, ["--fix", "--prune-suppressions"]);

    expect(args).toEqual(["--flag", "p", "--fix"]);
  });

  it("deletes a baseline pruning emptied, and keeps one with entries left", async () => {
    const root = repoWith(["packages/a/b.json", "packages/c/b.json"]);
    writeFileSync(join(root, "packages/c/b.json"), `{ "packages/c/x.ts": {} }`);

    const pruned = await Promise.all(["a", "c"].map((pkg) => argsOf(root, { patterns: ["p"], baseline: `packages/${pkg}/b.json` }, ["--prune-suppressions"])));

    expect(pruned[0]).toEqual(["--flag", "--suppressions-location", "packages/a/b.json", "p", "--prune-suppressions"]);
    expect(existsSync(join(root, "packages/a/b.json"))).toBe(false);
    expect(existsSync(join(root, "packages/c/b.json"))).toBe(true);
  });

  it.each(["--suppress-all", "--suppress-rule=no-undef"])("gives every package its own file under %s", (flag) => {
    const root = repoWith(ROOT_FILES);

    const units = lintUnits(groupsIn(root), baselineFinder(root, UNTYPED_BASELINE, [flag]), 600);

    expect(units.map((unit) => unit.baseline).sort()).toEqual(["packages/a", "packages/b", "packages/c"].map((dir) => `${dir}/${UNTYPED_BASELINE}`));
  });

  it("creates a baseline for root targets under scripts, never at the root", () => {
    const finder = baselineFinder(repoWith([]), UNTYPED_BASELINE, ["--suppress-all"]);

    expect(finder(".")).toBe(`scripts/${UNTYPED_BASELINE}`);
  });

  it.each([UNTYPED_BASELINE, TYPED_BASELINE])("refuses a run when %s sits at the root, where a shared unit would read it", (name) => {
    expect(rootBaselineRefusal(repoWith([name]))).toContain(name);
  });

  it("lets a run start when no baseline sits at the root", () => {
    expect(rootBaselineRefusal(repoWith([`packages/a/${UNTYPED_BASELINE}`]))).toBeUndefined();
  });

  it("leaves a package with no baseline shared under --prune-suppressions, which fails on a missing file", () => {
    const root = repoWith(ROOT_FILES);

    const finder = baselineFinder(root, UNTYPED_BASELINE, ["--prune-suppressions"]);

    expect(finder("packages/a")).toBeUndefined();
  });

  it("starts the largest unit first", () => {
    const root = repoWith(["packages/a/src/x.ts", "packages/b/src/x.ts", "packages/b/src/y.ts", `packages/a/${TYPED_BASELINE}`]);

    const units = lintUnits(groupsIn(root), baselineFinder(root, TYPED_BASELINE, []), 600);

    expect(units.map((unit) => unit.files)).toEqual([2, 1]);
  });
});

describe("the repo's baselines", () => {
  const baselines = () => globSync(`{packages,products,apps,deploy}/**/{${UNTYPED_BASELINE},${TYPED_BASELINE}}`, { cwd: REPO, exclude: (name) => name === "node_modules" });

  it("keeps none at the root, where one PR's edit would conflict with every other's", () => {
    expect(existsSync(join(REPO, UNTYPED_BASELINE))).toBe(false);
    expect(existsSync(join(REPO, TYPED_BASELINE))).toBe(false);
  });

  it("keys each entry inside the package whose file holds it, since a run only reads its own package's file", () => {
    const misplaced = baselines().flatMap((path) => {
      const owner = `${dirname(path)}/`;
      return Object.keys(JSON.parse(readFileSync(join(REPO, path), "utf8"))).filter((file) => !file.startsWith(owner));
    });

    expect(baselines().length).toBeGreaterThan(0);
    expect(misplaced).toEqual([]);
  });
});

describe("lint exit codes", () => {
  it.each([
    ["the abort signal", { status: null, signal: "SIGABRT" }],
    ["exit status 134", { status: 134, signal: null }],
  ])("names the chunk's dirs and exits 2 when a chunk dies on the heap cap with %s", (_, result) => {
    const { code, message } = chunkExit(result, ["products/factory/src"]);

    expect(code).toBe(2);
    expect(message).toContain("products/factory/src");
    expect(message).toContain("out of memory");
  });

  it("runs every unit after a lint failure and exits with the worst status", async () => {
    const statuses = [0, 1, 0];
    const ran = [];
    const run = async (unit) => {
      ran.push(unit.patterns);
      return { status: statuses[ran.length - 1], signal: null };
    };

    const code = await runUnits(unitsOfSize(1, 2, 3), { run, log: () => {}, limit: 1 });

    expect(code).toBe(1);
    expect(ran).toHaveLength(3);
  });

  it("exits 2 when one package's baseline is stale and a sibling unit started earlier finishes clean after it (TP-4651)", async () => {
    let finishSibling;
    const siblingDone = new Promise((resolve) => {
      finishSibling = resolve;
    });
    const run = async (unit) => {
      if (unit.patterns[0] === "g0") return siblingDone;
      finishSibling({ status: 0, signal: null });
      return { status: 2, signal: null, output: "There are suppressions left that do not occur anymore.\n" };
    };

    const code = await runUnits(unitsOfSize(2, 1), { run, log: () => {}, limit: 2 });

    expect(code).toBe(2);
  });

  it("never runs more units at once than the limit", async () => {
    let running = 0;
    let peak = 0;
    const run = async () => {
      peak = Math.max(peak, ++running);
      await Promise.resolve();
      running -= 1;
      return { status: 0, signal: null };
    };

    await runUnits(unitsOfSize(1, 1, 1, 1, 1), { run, log: () => {}, limit: 2 });

    expect(peak).toBe(2);
  });

  it("logs a unit's held-back output after its name", async () => {
    const lines = [];

    await runUnits(unitsOfSize(1), { run: async () => ({ status: 0, signal: null, output: "a warning\n" }), log: (line) => lines.push(line), limit: 4 });

    expect(lines).toEqual(["lint chunk 1/1: d0 (1 files)", "a warning"]);
  });
});

describe("lint:types --only", () => {
  const groups = [
    { pattern: "packages/a/src/**", dir: "packages/a", pkg: "packages/a", files: 1 },
    { pattern: "packages/b/src/**", dir: "packages/b", pkg: "packages/b", files: 1 },
    { pattern: "packages/a/scripts/**/*.ts", dir: "packages/a", pkg: "packages/a", files: 1 },
    { pattern: "apps/console/{src,server}/**", dir: "apps/console/{src,server}/**", pkg: "apps/console", files: 1 },
  ];

  it("keeps only the named packages' groups, every glob that covers them included", () => {
    // Mutant caught: no filtering lints every package.
    expect(groupsInPackages(groups, ["packages/a"]).map((g) => g.pattern)).toEqual(["packages/a/src/**", "packages/a/scripts/**/*.ts"]);
    expect(groupsInPackages(groups, ["apps/console"]).map((g) => g.pattern)).toEqual(["apps/console/{src,server}/**"]);
  });
});
