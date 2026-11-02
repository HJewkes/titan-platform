import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { countTestFiles, placement, runRequest, SHARD_ABOVE_FILES, vitestArgs } from "./test-scope.mjs";

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
