import { describe, expect, it } from "vitest";
import { compileGlobs, expandBraces } from "./glob.js";

describe("compileGlobs", () => {
  const isTest = compileGlobs(["**/*.{test,spec}.{ts,tsx,mts,js,mjs}"]);
  const isFixture = compileGlobs(["**/fixtures/**"]);

  it.each(["a.test.ts", "src/deep/a.spec.tsx", "pkg/x.test.mjs"])("matches test file %s", (path) => {
    expect(isTest(path)).toBe(true);
  });

  it.each(["a.ts", "src/a.test.ts.snap", "src/atest.ts", "src/a.test.cts"])("does not match %s", (path) => {
    expect(isTest(path)).toBe(false);
  });

  it("matches everything under a fixtures directory at any depth", () => {
    expect(isFixture("fixtures/a.json")).toBe(true);
    expect(isFixture("src/fixtures/deep/a.json")).toBe(true);
    expect(isFixture("src/myfixtures/a.json")).toBe(false);
  });

  it("keeps a single star inside one segment", () => {
    expect(compileGlobs(["src/*.ts"])("src/a/b.ts")).toBe(false);
  });

  it("refuses a brace glob with too many alternatives", () => {
    expect(() => expandBraces("{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b}")).toThrow(/256/);
  });
});
