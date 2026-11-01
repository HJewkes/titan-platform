import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkClosures, closureOf, closureVerdict, type ClosureLock } from "./closure.js";

const row = (closure: string, bump = 0) => ({ closure, schemaHash: "schema-1", bump });
const base: ClosureLock = { "ci-wait": row("closure-a") };
const moved: ClosureLock = { "ci-wait": row("closure-b") };

const repo = mkdtempSync(join(tmpdir(), "closure-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function put(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

/** A body importing a sibling that imports a workspace package, linked into node_modules as pnpm does. */
function seedWorkspace(): void {
  put("products/app/src/body.ts", 'import { sibling } from "./sibling.js";\nexport const body = sibling;\n');
  put("products/app/src/sibling.ts", 'import { leaf } from "@titan-design/fake";\nimport { z } from "zod";\nexport const sibling = [leaf, z];\n');
  put("packages/fake/package.json", JSON.stringify({ name: "@titan-design/fake", type: "module", exports: { ".": { types: "./dist/index.d.ts" } } }));
  put("packages/fake/dist/index.d.ts", "export declare const leaf: number;\n");
  put("packages/fake/src/index.ts", 'export { leaf } from "./leaf.js";\n');
  put("packages/fake/src/leaf.ts", "export const leaf = 1;\n");
  put("node_modules/zod/package.json", JSON.stringify({ name: "zod", type: "module", exports: { ".": { types: "./index.d.ts" } } }));
  put("node_modules/zod/index.d.ts", "export declare const z: number;\n");
  mkdirSync(join(repo, "node_modules/@titan-design"), { recursive: true });
  symlinkSync(join(repo, "packages/fake"), join(repo, "node_modules/@titan-design/fake"));
}

describe("step closure lint", () => {
  it("a closure that changed at an unchanged schema hash and bump fails", () => {
    expect(closureVerdict(base, moved, [])).toEqual([expect.stringContaining("ci-wait")]);
  });

  it("the same change passes with a bump", () => {
    expect(closureVerdict(base, { "ci-wait": row("closure-b", 1) }, [])).toEqual([]);
  });

  it("the same change passes when an attestation names the new closure", () => {
    expect(closureVerdict(base, moved, [{ step: "ci-wait", closure: "closure-b", pr: 1 }])).toEqual([]);
  });

  it("an attestation for a different closure does not pass", () => {
    expect(closureVerdict(base, moved, [{ step: "ci-wait", closure: "closure-a", pr: 1 }])).toHaveLength(1);
  });

  it("a change in a transitively imported workspace file changes the closure", () => {
    seedWorkspace();
    const before = closureOf(repo, "products/app/src/body.ts");
    put("packages/fake/src/leaf.ts", "export const leaf = 2;\n");
    const after = closureOf(repo, "products/app/src/body.ts");

    expect(before.files).toEqual(["packages/fake/src/index.ts", "packages/fake/src/leaf.ts", "products/app/src/body.ts", "products/app/src/sibling.ts"]);
    expect(after.hash).not.toBe(before.hash);
  });

  it("a stale head lock fails", () => {
    const result = checkClosures({ base, committed: base, computed: moved, attestations: [] });

    expect(result.failures).toEqual([expect.stringContaining("stale")]);
  });

  it("a missing base lock passes with a notice", () => {
    const result = checkClosures({ base: undefined, committed: moved, computed: moved, attestations: [] });

    expect(result).toEqual({ failures: [], notices: [expect.stringContaining("no base")] });
  });
});
