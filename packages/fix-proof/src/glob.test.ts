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

  it("rejects a huge brace product before building it", () => {
    const alternatives = (count: number): string => `{${Array.from({ length: count }, (_, i) => `a${i}`).join(",")}}`;
    const started = performance.now();
    expect(() => expandBraces(`${alternatives(4096)}${alternatives(256)}`)).toThrow(Error);
    expect(() => expandBraces(`${alternatives(30)}${alternatives(30)}`)).toThrow(/256/);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("rejects nested groups early", () => {
    const inner = `{${Array.from({ length: 8 }, (_, i) => `b${i}`).join(",")}}`;
    const glob = `{${Array.from({ length: 8 }, (_, i) => `a${i}${inner}`).join(",")}}${inner}`;
    const started = performance.now();
    expect(() => expandBraces(glob)).toThrow(/256/);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("expands nested and empty alternatives", () => {
    expect(new Set(expandBraces("a{b,{c,d}}"))).toEqual(new Set(["ab", "ac", "ad"]));
    expect(expandBraces("a{,b}")).toEqual(["a", "ab"]);
  });

  it.each([
    ["2000 single-choice groups", "{a}".repeat(2000)],
    ["20000 single-choice groups", "{a}".repeat(20000)],
    ["a 2KB glob", "a".repeat(2048)],
  ])("rejects %s before expanding", (_name, glob) => {
    const started = performance.now();
    expect(() => expandBraces(glob)).toThrow(Error);
    expect(() => compileGlobs([glob])).toThrow(Error);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("accepts 32 brace groups", () => {
    expect(expandBraces("{a}".repeat(32))).toEqual(["a".repeat(32)]);
  });
});

// The backtracking compiler this replaced, kept as the oracle for what each glob means.
function referenceRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    if (glob.startsWith("**/", index)) {
      source += "(?:[^/]+/)*";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 1;
    } else {
      const char = glob.charAt(index);
      source += char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.+^$()|[\]\\{}]/, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function seededRandom(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % below;
  };
}

describe("compileGlobs on hostile globs", () => {
  it.each([
    ["d/ and 20 stars", `d/${"*".repeat(20)}x`, `d/${"a".repeat(40)}`],
    ["12 globstar segments", `${"**/".repeat(12)}x`, `${"a/".repeat(40)}b`],
    ["10 globstar-a runs", "**a".repeat(10), `${"a".repeat(40)}b`],
    ["10 star-a runs", `d/${"*a".repeat(10)}`, `d/${"a".repeat(40)}b`],
    ["alternating globstar and star segments", `${"**/*/".repeat(8)}x`, `${"a/".repeat(40)}b`],
  ])("rejects a non-matching path quickly for %s", (_name, glob, path) => {
    const matches = compileGlobs([glob]);
    const started = performance.now();
    expect(matches(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it.each([
    ["d/**x", ["d/x", "d/a/b/x", "d/ax"], ["d/a/b", "e/x"]],
    ["**/**/a", ["a", "b/a", "b/c/a"], ["ba", "b/", "/a"]],
    ["a/**/*.ts", ["a/x.ts", "a/b/c/x.ts", "a/.ts"], ["a.ts", "b/x.ts", "a/x.tsx"]],
    ["a?c", ["abc", "a.c"], ["a/c", "ac", "abbc"]],
  ])("matches %s like the backtracking compiler did", (glob, hits, misses) => {
    const matches = compileGlobs([glob]);
    expect(hits.map(matches)).toEqual(hits.map(() => true));
    expect(misses.map(matches)).toEqual(misses.map(() => false));
  });

  it("agrees with the backtracking compiler on 5000 random globs and paths", () => {
    const random = seededRandom(1756);
    const pick = (pieces: readonly string[], most: number): string =>
      Array.from({ length: random(most + 1) }, () => pieces[random(pieces.length)]).join("");
    const disagreements: string[] = [];
    for (let round = 0; round < 5000; round += 1) {
      const glob = pick(["a", "b", "/", ".", "*", "?", "**", "**/"], 6);
      const path = pick(["a", "b", "/", "."], 8);
      if (compileGlobs([glob])(path) !== referenceRegExp(glob).test(path)) disagreements.push(`${glob} ${path}`);
    }
    expect(disagreements).toEqual([]);
  });
});
