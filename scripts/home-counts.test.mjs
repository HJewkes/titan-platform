import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fillCounts, homeCounts, roundedTestCount } from "../site/home-counts.data.mjs";

const roots = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function touch(root, path, text = "") {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Two publishable packages, one private package and one product, with no test files yet. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "home-counts-"));
  roots.push(root);
  const $tiers = { 0: ["packages/alpha", "packages/beta", "packages/hidden"], product: ["products/app"] };
  touch(root, ".codewatch/check.json", JSON.stringify({ rules: [{ type: "layered-deps", $tiers }] }));
  touch(root, "apps/.gitkeep");
  for (const dir of ["alpha", "beta"]) touch(root, `packages/${dir}/package.json`, JSON.stringify({ name: `@titan-design/${dir}` }));
  touch(root, "packages/hidden/package.json", JSON.stringify({ name: "@titan-design/hidden", private: true }));
  touch(root, "products/app/package.json", JSON.stringify({ name: "@titan-design/app", private: true }));
  return root;
}

describe("landing page counts", () => {
  it("floors the test files under the workspace globs to the hundred, skipping build output and dependencies", () => {
    const root = workspace();
    for (let i = 0; i < 150; i += 1) touch(root, `packages/alpha/src/t${i}.test.ts`);
    for (let i = 0; i < 60; i += 1) touch(root, `products/app/test/nested/t${i}.test.mjs`);
    touch(root, "deploy/hub/a.test.ts");
    touch(root, "packages/alpha/src/not-a-test.ts");
    for (const skipped of ["dist", "node_modules/dep", "coverage", ".cache"]) {
      for (let i = 0; i < 100; i += 1) touch(root, `packages/beta/${skipped}/t${i}.test.js`);
    }
    for (let i = 0; i < 100; i += 1) touch(root, `scripts/t${i}.test.mjs`);

    expect(homeCounts(root)["test-file-count"]).toBe(roundedTestCount(211));
    expect(homeCounts(root)["test-file-count"]).toBe("200+");
  });

  it("counts only the publishable packages under packages/", () => {
    expect(homeCounts(workspace())["package-count"]).toBe("2");
  });

  it("floors the test-file count with a thousands separator and a plus sign", () => {
    expect([99, 1874, 1899, 1900].map(roundedTestCount)).toEqual(["0+", "1,800+", "1,800+", "1,900+"]);
  });

  it("fills each count token in the tagline and refuses a tagline that lost one", () => {
    const counts = { "package-count": "2", "test-file-count": "200+" };

    expect(fillCounts("{package-count} packages and {test-file-count} tests.", counts)).toBe("2 packages and 200+ tests.");
    expect(() => fillCounts("{package-count} packages.", counts)).toThrow(/no \{test-file-count\} token/);
  });
});
