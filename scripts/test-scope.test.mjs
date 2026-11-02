import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countTestFiles,
  placement,
  readWorkspace,
  runRequest,
  SHARD_ABOVE_FILES,
  scopeForEvent,
  testScope,
  vitestArgs,
} from "./test-scope.mjs";

// store -> mid -> factory, plus a leaf nothing depends on.
const workspace = [
  { dir: "packages/store/", name: "@fx/store", deps: [] },
  { dir: "packages/mid/", name: "@fx/mid", deps: ["@fx/store", "left-pad"] },
  { dir: "products/factory/", name: "@fx/factory", deps: ["@fx/mid"] },
  { dir: "packages/leaf/", name: "@fx/leaf", deps: [] },
  { dir: "deploy/hub/", name: "@fx/hub", deps: ["@fx/leaf"] },
];

describe("testScope", () => {
  it("runs only the changed package and the root script tests when nothing depends on it", () => {
    const scope = testScope(["products/factory/src/route.ts"], workspace);

    expect(scope).toEqual({ mode: "scoped", dirs: ["products/factory/", "scripts/"] });
  });

  it("adds every package that depends on a changed one, through the whole chain", () => {
    const scope = testScope(["packages/store/src/db.ts"], workspace);

    expect(scope).toEqual({ mode: "scoped", dirs: ["packages/mid/", "packages/store/", "products/factory/", "scripts/"] });
  });

  it("treats a package's own package.json as a change to that package", () => {
    const scope = testScope(["packages/leaf/package.json"], workspace);

    expect(scope).toEqual({ mode: "scoped", dirs: ["deploy/hub/", "packages/leaf/", "scripts/"] });
  });

  it.each(["package.json", "vitest.config.ts", ".github/workflows/ci.yml", "scripts/fixtures/x.json"])(
    "runs everything when %s changes",
    (path) => {
      expect(testScope(["packages/leaf/src/a.ts", path], workspace)).toEqual({ mode: "full", reason: path });
    },
  );

  it("runs everything for a path it does not recognise, such as a new top-level dir", () => {
    expect(testScope(["newdir/thing.ts"], workspace)).toEqual({ mode: "full", reason: "newdir/thing.ts" });
  });

  it("runs everything for a file in a package dir that is not a workspace member", () => {
    expect(testScope(["packages/removed/src/a.ts"], workspace).mode).toBe("full");
  });

  it("runs no tests for a diff of changesets and docs only", () => {
    const scope = testScope([".changeset/brave-fox.md", "site/guides/intro.md", "README.md"], workspace);

    expect(scope).toEqual({ mode: "none" });
  });

  it.each(["eslint-suppressions.json", "eslint-suppressions.typed.json", "packages/leaf/eslint-suppressions.typed.json"])(
    "runs only the root script tests, which guard baselines, when %s changes",
    (path) => {
      expect(testScope([path], workspace)).toEqual({ mode: "scoped", dirs: ["scripts/"] });
    },
  );

  it.each(["CLAUDE.md", "AGENTS.md"])("runs the root script tests for %s, which the structure test reads live", (path) => {
    expect(testScope([path], workspace)).toEqual({ mode: "scoped", dirs: ["scripts/"] });
  });

  it("runs factory for the docs page its escalation test reads", () => {
    const scope = testScope(["site/guides/shepherd.md"], workspace);

    expect(scope).toEqual({ mode: "scoped", dirs: ["products/factory/", "scripts/"] });
  });

  it("runs only the root script tests for a script change", () => {
    expect(testScope(["scripts/graph-gate.mjs"], workspace)).toEqual({ mode: "scoped", dirs: ["scripts/"] });
  });

  it("runs everything for an empty diff", () => {
    expect(testScope([], workspace).mode).toBe("full");
  });
});

describe("scopeForEvent", () => {
  const pr = { EVENT_NAME: "pull_request", HEAD_REF: "feat/x", BASE_SHA: "a".repeat(40), HEAD_SHA: "b".repeat(40) };
  const factoryDiff = () => ["products/factory/src/route.ts"];
  const fixture = () => workspace;

  it("scopes a pull request by its own diff", () => {
    expect(scopeForEvent(pr, factoryDiff, fixture).mode).toBe("scoped");
  });

  it("runs everything on a push, so main stays the authority", () => {
    expect(scopeForEvent({ ...pr, EVENT_NAME: "push" }, factoryDiff, fixture).mode).toBe("full");
  });

  it("runs everything on the release PR", () => {
    expect(scopeForEvent({ ...pr, HEAD_REF: "changeset-release/main" }, factoryDiff, fixture).mode).toBe("full");
  });

  it("reads the lockfile at the PR's base and head when the diff changes it", () => {
    const shas = [];
    const readLock = (...args) => {
      shas.push(args);
      return { base: "importers: {}", head: "importers: {}" };
    };

    const scope = scopeForEvent(pr, () => ["pnpm-lock.yaml", ...factoryDiff()], fixture, readLock);

    expect(shas).toEqual([[pr.BASE_SHA, pr.HEAD_SHA]]);
    expect(scope).toEqual({ mode: "scoped", dirs: ["products/factory/", "scripts/"] });
  });

  it("runs everything when the diff cannot be read", () => {
    const failing = () => {
      throw new Error("fatal: bad revision");
    };

    expect(scopeForEvent(pr, failing, fixture)).toEqual({ mode: "full", reason: "scope unreadable: fatal: bad revision" });
  });
});

describe("vitestArgs", () => {
  it("names every project and the scoped dirs", () => {
    expect(vitestArgs({ mode: "scoped", dirs: ["products/factory/", "scripts/"] })).toEqual([
      "run",
      "--passWithNoTests",
      "--project",
      "threads",
      "--project",
      "factory",
      "--project",
      "explainer",
      "--project",
      "console",
      "--project",
      "isolated",
      "--project",
      "repo",
      "--project",
      "forks",
      "--project",
      "perf",
      "--project",
      "active-work",
      "--project",
      "active-work-forks",
      "products/factory/",
      "scripts/",
    ]);
  });

  it("passes no filter for a full run", () => {
    expect(vitestArgs({ mode: "full", reason: "push" })).toEqual(["run", "--passWithNoTests"]);
  });

  // A CI run once hung 74 minutes past its last file with nothing naming the culprit (TP-4287).
  it("adds the hang reporters on CI, keeping the default output beside them", () => {
    expect(vitestArgs({ mode: "full", reason: "push" }, { CI: "true" })).toEqual([
      "run",
      "--passWithNoTests",
      "--reporter=default",
      "--reporter=hanging-process",
      "--reporter=./scripts/vitest-file-watchdog.mjs",
      "--reporter=./scripts/vitest-file-timing.mjs",
    ]);
  });
});

// A scope of ~1800 files took up to 680 s in validate alone, against its 600 s job budget (TP-4730).
describe("placement", () => {
  const scoped = { mode: "scoped", dirs: ["products/factory/", "scripts/"] };

  it("keeps a scope at the threshold in validate", () => {
    expect(placement(scoped, () => SHARD_ABOVE_FILES)).toBe("validate");
  });

  it("sends a scope past the threshold to the test-shard matrix", () => {
    expect(placement(scoped, () => SHARD_ABOVE_FILES + 1)).toBe("shards");
  });

  it("always shards the full suite and places an empty scope nowhere", () => {
    expect(placement({ mode: "full", reason: "push" }, () => 0)).toBe("shards");
    expect(placement({ mode: "none" }, () => 0)).toBe("none");
  });

  it("counts the scope's own dirs", () => {
    const seen = [];
    placement(scoped, (dirs) => (seen.push(dirs), 0));

    expect(seen).toEqual([scoped.dirs]);
  });
});

describe("countTestFiles", () => {
  it("counts test files in the dirs by vitest's suffixes, skipping node_modules and other dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "test-scope-count-"));
    const files = ["a/src/x.test.ts", "a/src/y.test.tsx", "a/src/x.ts", "a/node_modules/dep/z.test.ts", "b/w.test.mjs", "c/v.test.ts"];
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "");
    }

    expect(countTestFiles(["a/", "b/"], root)).toBe(3);
  });
});

describe("runRequest", () => {
  const scoped = { mode: "scoped", dirs: ["scripts/"] };
  const full = { mode: "full", reason: "push" };

  it("runs nothing without --run, or for a scope with no tests", () => {
    expect(runRequest(scoped, "validate", ["--plan"])).toBeNull();
    expect(runRequest({ mode: "none" }, "none", ["--run"])).toBeNull();
  });

  it("leaves a sharded scope to the matrix when validate asks to skip it", () => {
    expect(runRequest(full, "shards", ["--run", "--skip-sharded"])).toBeNull();
    expect(runRequest(scoped, "validate", ["--run", "--skip-sharded"])).toEqual(vitestArgs(scoped));
  });

  it("still runs a large scope whole for a local --run", () => {
    expect(runRequest(full, "shards", ["--run"])).toEqual(vitestArgs(full));
  });

  it("passes a shard through to vitest after the scope's own arguments", () => {
    const args = runRequest(scoped, "shards", ["--run", "--shard=2/3"], { CI: "true" });

    expect(args).toEqual([...vitestArgs(scoped, { CI: "true" }), "--shard=2/3"]);
  });
});

describe("readWorkspace on this repo", () => {
  it("finds the members, so a test-kit change reaches the packages that test with it", () => {
    const members = readWorkspace();

    const scope = testScope(["packages/test-kit/src/index.ts"], members);

    expect(members.map((member) => member.dir)).toContain("deploy/hub/");
    expect(scope.mode).toBe("scoped");
    expect(scope.dirs).toEqual(expect.arrayContaining(["packages/test-kit/", "products/factory/"]));
  });
});

describe("the root scripts factory's audit test runs", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const RELATIVE_IMPORT = /from\s+"\.\/([\w.-]+\.mjs)"/g;
  const DIST_LOAD = /"packages",\s*"([\w-]+)",\s*"dist"/g;

  function reachedFrom(entry, seen = new Set()) {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    for (const [, file] of read(entry).matchAll(RELATIVE_IMPORT)) reachedFrom(`scripts/${file}`, seen);
    return seen;
  }

  it("scope factory, as do the packages those scripts load from dist, beside their own tests", () => {
    expect(read("products/factory/src/audit/production.ts")).toContain('join(checkout, "scripts", "areas.mjs")');
    const scripts = [...reachedFrom("scripts/areas.mjs")];
    const loaded = scripts.flatMap((file) => [...read(file).matchAll(DIST_LOAD)].map(([, name]) => `packages/${name}/`));
    const members = readWorkspace();

    expect(scripts).toContain("scripts/new-package.mjs");
    expect(loaded).toContain("packages/pm/");
    for (const path of scripts) expect(testScope([path], members).dirs, path).toContain("products/factory/");
    for (const dir of loaded) {
      expect(testScope([`${dir}src/index.ts`], members).dirs, dir).toEqual(expect.arrayContaining([dir, "products/factory/"]));
    }
  });
});

describe("readWorkspace on this repo, for an import only a test makes", () => {
  it("reaches coordinator from egress-scan, which coordinator's example test imports", () => {
    expect(testScope(["packages/egress-scan/src/scan.ts"], readWorkspace()).dirs).toContain("packages/coordinator/");
  });
});
