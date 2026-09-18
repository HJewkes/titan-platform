import { describe, it, expect } from "vitest";
import { parseFile, type ParsedFile } from "@titan-design/code-parser";
import { computeGrowthRiskMetrics } from "./growth-risk.js";

const idOf = (p: string): string => p;
async function parseTs(code: string, fp = "f.ts"): Promise<ParsedFile> {
  return parseFile(code, fp, "typescript");
}
function loopDepth(metrics: ReturnType<typeof computeGrowthRiskMetrics>): number | undefined {
  return metrics.find((m) => m.name === "loop_depth")?.value ?? undefined;
}
function metric(
  metrics: ReturnType<typeof computeGrowthRiskMetrics>,
  name: string,
): number {
  return metrics.find((m) => m.name === name)?.value ?? 0;
}

describe("computeGrowthRiskMetrics — loop_depth (C-66)", () => {
  it("flags a doubly-nested loop as depth 2 (quadratic-shaped)", async () => {
    const f = await parseTs(
      `function f(a: number[][]) { for (const row of a) { for (const x of row) { g(x); } } }`,
    );
    expect(loopDepth(computeGrowthRiskMetrics([f], idOf))).toBe(2);
  });

  it("counts a triply-nested loop as depth 3", async () => {
    const f = await parseTs(
      `function f() { for (;;) { while (true) { for (const x of y) { g(x); } } } }`,
    );
    expect(loopDepth(computeGrowthRiskMetrics([f], idOf))).toBe(3);
  });

  it("counts loop nesting through a nested closure (forEach + inner loop)", async () => {
    const f = await parseTs(
      `function f(a: number[]) { for (const x of a) { a.forEach((y) => { for (const z of y) { g(z); } }); } }`,
    );
    expect(loopDepth(computeGrowthRiskMetrics([f], idOf))).toBe(2);
  });

  it("does NOT flag two sequential (non-nested) loops", async () => {
    const f = await parseTs(
      `function f(a: number[]) { for (const x of a) { g(x); } for (const y of a) { g(y); } }`,
    );
    expect(computeGrowthRiskMetrics([f], idOf)).toEqual([]);
  });

  it("does NOT flag a single loop (depth 1 is unremarkable)", async () => {
    const f = await parseTs(`function f(a: number[]) { for (const x of a) { g(x); } }`);
    expect(computeGrowthRiskMetrics([f], idOf)).toEqual([]);
  });

  it("does NOT count if-nesting as loop depth", async () => {
    const f = await parseTs(
      `function f(x: number) { if (x) { if (x > 1) { if (x > 2) { for (;;) { g(x); } } } } }`,
    );
    // Only one loop, however deep the if-nesting — not a scaling smell.
    expect(computeGrowthRiskMetrics([f], idOf)).toEqual([]);
  });

  it("counts Python nested loops too", async () => {
    const f = await parseFile(
      `def f(a):\n    for row in a:\n        for x in row:\n            g(x)\n`,
      "f.py",
      "python",
    );
    expect(loopDepth(computeGrowthRiskMetrics([f], idOf))).toBe(2);
  });
});

describe("computeGrowthRiskMetrics — recursion (C-66)", () => {
  it("flags a directly self-recursive function", async () => {
    const f = await parseTs(`function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }`);
    expect(metric(computeGrowthRiskMetrics([f], idOf), "recursive_functions")).toBe(1);
  });

  it("does not flag a non-recursive function", async () => {
    const f = await parseTs(`function f(n: number) { return g(n) + h(n); }`);
    expect(metric(computeGrowthRiskMetrics([f], idOf), "recursive_functions")).toBe(0);
  });
});

describe("computeGrowthRiskMetrics — search in loop (C-66)", () => {
  it("flags a .includes() call inside a loop", async () => {
    const f = await parseTs(
      `function f(a: number[], b: number[]) { for (const x of a) { if (b.includes(x)) g(x); } }`,
    );
    expect(metric(computeGrowthRiskMetrics([f], idOf), "search_in_loop")).toBe(1);
  });

  it("counts .find and .indexOf too, and only inside loops", async () => {
    const f = await parseTs(
      `function f(a: number[]) {\n` +
        `  const outside = a.find((x) => x > 0);\n` + // NOT in a loop
        `  for (const y of a) { a.indexOf(y); a.find((z) => z === y); }\n` +
        `  return outside;\n` +
        `}`,
    );
    expect(metric(computeGrowthRiskMetrics([f], idOf), "search_in_loop")).toBe(2);
  });
});
