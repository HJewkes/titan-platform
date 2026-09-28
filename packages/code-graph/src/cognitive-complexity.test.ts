import { describe, it, expect } from "vitest";
import { parseFile, type ParsedFile } from "@titan-design/code-parser";
import { computeSourceMetrics } from "./source-metrics.js";

const idOf = (p: string): string => p;

async function parseTs(code: string, filePath = "f.ts"): Promise<ParsedFile> {
  return parseFile(code, filePath, "typescript");
}

async function parsePy(code: string, filePath = "f.py"): Promise<ParsedFile> {
  return parseFile(code, filePath, "python");
}

function score(metrics: ReturnType<typeof computeSourceMetrics>): number {
  return metrics.find((m) => m.name === "cognitive_max")!.value as number;
}

describe("cognitive complexity — TypeScript", () => {
  it("scores a linear function as 0", async () => {
    const file = await parseTs(`function f() { return 1 + 2; }`);
    const metrics = computeSourceMetrics([file], idOf);
    expect(score(metrics)).toBe(0);
  });

  it("scores a single if as 1", async () => {
    const file = await parseTs(`function f(x: number) { if (x > 0) return 1; }`);
    const metrics = computeSourceMetrics([file], idOf);
    expect(score(metrics)).toBe(1);
  });

  it("scores a nested if as 1 + 2 (nesting bonus)", async () => {
    const file = await parseTs(`
      function f(x: number, y: number) {
        if (x > 0) {
          if (y > 0) {
            return 1;
          }
        }
      }
    `);
    const metrics = computeSourceMetrics([file], idOf);
    // outer if: 1 + 0 = 1; inner if: 1 + 1 = 2. Total = 3.
    expect(score(metrics)).toBe(3);
  });

  it("does NOT explode on flat else-if chains", async () => {
    const file = await parseTs(`
      function f(x: number) {
        if (x === 1) return 1;
        else if (x === 2) return 2;
        else if (x === 3) return 3;
        else return 0;
      }
    `);
    const metrics = computeSourceMetrics([file], idOf);
    // if: 1; else-if 1: +1; else-if 2: +1; else: +1. Total = 4.
    expect(score(metrics)).toBe(4);
  });

  it("counts a chain of like logical operators as one increment", async () => {
    // Sonarsource: a sequence of like operators counts once (+1), not per
    // occurrence. `a && b && c` is one && chain.
    const file = await parseTs(`
      function f(a: boolean, b: boolean, c: boolean) {
        if (a && b && c) return 1;
      }
    `);
    const metrics = computeSourceMetrics([file], idOf);
    // if: 1; one && chain: +1. Total = 2.
    expect(score(metrics)).toBe(2);
  });

  it("counts each kind transition in a mixed logical chain", async () => {
    // `(a && b) || c` — two sequences (&&, then ||), +1 each.
    const file = await parseTs(`
      function f(a: boolean, b: boolean, c: boolean) {
        if (a && b || c) return 1;
      }
    `);
    const metrics = computeSourceMetrics([file], idOf);
    // if: 1; &&: +1; ||: +1. Total = 3.
    expect(score(metrics)).toBe(3);
  });

  it("scores switch as 1 (not per-case)", async () => {
    const file = await parseTs(`
      function f(x: number) {
        switch (x) {
          case 1: return 'a';
          case 2: return 'b';
          case 3: return 'c';
          default: return 'z';
        }
      }
    `);
    const metrics = computeSourceMetrics([file], idOf);
    expect(score(metrics)).toBe(1);
  });

  it("scores a for inside an if with nesting bonus", async () => {
    const file = await parseTs(`
      function f(xs: number[]) {
        if (xs.length > 0) {
          for (const x of xs) {
            if (x < 0) return -1;
          }
        }
        return 0;
      }
    `);
    const metrics = computeSourceMetrics([file], idOf);
    // if: 1; for nested 1: 1+1=2; if nested 2: 1+2=3. Total = 6.
    expect(score(metrics)).toBe(6);
  });

  it("emits both cognitive_max and cognitive_sum", async () => {
    const file = await parseTs(`
      function a(x: number) { if (x > 0) return 1; }
      function b(x: number) { if (x > 0) { if (x > 1) return 2; } }
    `);
    const metrics = computeSourceMetrics([file], idOf);
    const max = metrics.find((m) => m.name === "cognitive_max")!.value;
    const sum = metrics.find((m) => m.name === "cognitive_sum")!.value;
    expect(max).toBe(3); // function b
    expect(sum).toBe(4); // 1 + 3
  });
});

describe("cognitive complexity — Python", () => {
  it("scores a single if as 1", async () => {
    const file = await parsePy(`
def f(x):
    if x > 0:
        return 1
`);
    const metrics = computeSourceMetrics([file], idOf);
    expect(score(metrics)).toBe(1);
  });

  it("does not explode on elif chains", async () => {
    const file = await parsePy(`
def f(x):
    if x == 1:
        return 1
    elif x == 2:
        return 2
    elif x == 3:
        return 3
    else:
        return 0
`);
    const metrics = computeSourceMetrics([file], idOf);
    // if + 2 elif + else = 4. (if: +1; each elif and else: +1.)
    expect(score(metrics)).toBe(4);
  });

  it("counts a chain of like boolean operators (and/or) as one increment", async () => {
    const file = await parsePy(`
def f(a, b, c):
    if a and b and c:
        return 1
`);
    const metrics = computeSourceMetrics([file], idOf);
    // if: 1; one `and` chain: +1. Total = 2.
    expect(score(metrics)).toBe(2);
  });

  it("counts each kind transition in a mixed and/or chain", async () => {
    const file = await parsePy(`
def f(a, b, c):
    if a and b or c:
        return 1
`);
    const metrics = computeSourceMetrics([file], idOf);
    // if: 1; `and`: +1; `or`: +1. Total = 3.
    expect(score(metrics)).toBe(3);
  });
});
