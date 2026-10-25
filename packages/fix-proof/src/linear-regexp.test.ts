import { LINEAR_GROWTH_LIMIT, linearGrowth } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { LinearRegExp } from "./linear-regexp.js";

function seededRandom(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 16) % below;
  };
}

const INPUT_CHARS = ["a", "A", "b", "/", ".", "\n"];
const INPUTS = [""];
for (let index = 0; INPUTS.length < 1 + 6 + 36 + 216 + 1296; index += 1) INPUTS.push(...INPUT_CHARS.map((c) => `${INPUTS[index]}${c}`));

// The pieces the repo's glob compilers emit, plus syntax that only sometimes forms a valid source.
const PIECES = ["a", "b", "/", "\\.", ".", "[^/]", "[ab]", "[^a]", "[]", "(?:", "(", ")", "|", "*", "+", "?", "^", "$", "(?:.*/)?", "[A-Z]"];

function compiled(build: () => RegExp): RegExp | null {
  try {
    return build();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function agreement(source: string, flags: string): string[] {
  const native = compiled(() => new RegExp(source, flags));
  const linear = compiled(() => new LinearRegExp(source, flags));
  if (native === null || linear === null) return native === linear ? [] : [`/${source}/${flags} compiles in only one engine`];
  return INPUTS.filter((input) => linear.test(input) !== native.test(input)).map((input) => `/${source}/${flags} ${JSON.stringify(input)}`);
}

describe("LinearRegExp", () => {
  it("agrees with RegExp on 400 random sources, under each of its flags, on every input up to 4 characters", () => {
    const random = seededRandom(4223);
    const disagreements: string[] = [];
    for (let round = 0; round < 400; round += 1) {
      const source = Array.from({ length: 1 + random(7) }, () => PIECES[random(PIECES.length)]).join("");
      for (const flags of ["", "i", "s", "si"]) disagreements.push(...agreement(source, flags));
    }
    expect(disagreements).toEqual([]);
  });

  it.each([["(?=a)"], ["(?<n>a)"], ["a{2}"], ["(a)\\1"], ["\\bword"], ["\\x41"]])("refuses %s, which it does not model", (source) => {
    expect(() => new LinearRegExp(source)).toThrow(SyntaxError);
  });

  it("refuses the g and y flags, since it keeps no lastIndex", () => {
    expect(() => new LinearRegExp("a", "g")).toThrow(SyntaxError);
    expect(() => new LinearRegExp("a", "y")).toThrow(SyntaxError);
  });

  it("is still a RegExp, whose exec and match report the whole input", () => {
    const glob = new LinearRegExp("^src/[^/]*\\.ts$");
    expect(glob).toBeInstanceOf(RegExp);
    expect(glob.source).toBe(new RegExp("^src/[^/]*\\.ts$").source);
    expect("src/a.ts".match(glob)?.[0]).toBe("src/a.ts");
    expect(glob.exec("src/a/b.ts")).toBeNull();
  });

  it("tests with the given matcher in place of the compiled source", () => {
    const glob = new LinearRegExp("(?!b)a", "", (input) => input === "only");
    expect(glob.test("only")).toBe(true);
    expect(glob.test("a")).toBe(false);
  });

  it.each([
    ["d/ and 20 stars", `^d/${"[^/]*".repeat(20)}x$`, (n: number) => `d/${"a".repeat(n)}`],
    ["12 globstar segments", `^${"(?:.*/)?".repeat(12)}x$`, (n: number) => `${"a/".repeat(n)}b`],
  ])("grows linearly with the path for %s", (_name, source, path) => {
    const regexp = new LinearRegExp(source);
    const { ratio } = linearGrowth((n) => {
      const input = path(n);
      return () => regexp.test(input);
    }, { from: 1, to: 1024 });
    expect(ratio).toBeLessThan(LINEAR_GROWTH_LIMIT);
  }, 60_000);
});
