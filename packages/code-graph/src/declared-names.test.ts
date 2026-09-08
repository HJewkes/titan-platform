import { describe, expect, it } from "vitest";
import { parseFile } from "./parser/index.js";
import { collectDeclaredNames, collectDeclaredSpans } from "./declared-names.js";

const TS = `// a comment
export function alpha(): void {}

const beta = (n: number) => n + 1;

class Gamma {
  delta(): void {}
}
`;

const PY = `def alpha():
    return 1


class Gamma:
    def delta(self):
        return 2
`;

describe("declared names", () => {
  it("collects functions, arrow consts, classes and methods from TypeScript", async () => {
    const file = await parseFile(TS, "/repo/src/a.ts", "typescript");
    expect([...collectDeclaredNames(file)].sort()).toEqual(["Gamma", "alpha", "beta", "delta"]);
  });

  it("collects Python functions and classes with 1-based line spans", async () => {
    const file = await parseFile(PY, "/repo/src/a.py", "python");
    const spans = collectDeclaredSpans(file);
    expect([...spans.keys()].sort()).toEqual(["Gamma", "alpha", "delta"]);
    expect(spans.get("alpha")).toEqual({ startLine: 1, endLine: 2 });
  });

  it("skips anonymous declarations", async () => {
    const file = await parseFile("export default () => 1;\n", "/repo/src/a.ts", "typescript");
    expect(collectDeclaredNames(file).size).toBe(0);
  });
});
