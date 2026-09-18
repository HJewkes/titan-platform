import { describe, it, expect } from "vitest";
import { parseFile, type ParsedFile } from "@titan-design/code-parser";
import { computeDeadCodeMetrics } from "./dead-code.js";

const idOf = (p: string): string => p;
async function parseTs(code: string, fp = "f.ts"): Promise<ParsedFile> {
  return parseFile(code, fp, "typescript");
}
function unreachable(metrics: ReturnType<typeof computeDeadCodeMetrics>): number | undefined {
  return metrics.find((m) => m.name === "unreachable_statements")?.value ?? undefined;
}
function metric(
  metrics: ReturnType<typeof computeDeadCodeMetrics>,
  name: string,
): number {
  return metrics.find((m) => m.name === name)?.value ?? 0;
}

describe("computeDeadCodeMetrics — unreachable statements (C-65)", () => {
  it("counts a statement after a return", async () => {
    const f = await parseTs(`function a() { return 1; const dead = 2; }`);
    expect(unreachable(computeDeadCodeMetrics([f], idOf))).toBe(1);
  });

  it("counts every statement after an unconditional throw", async () => {
    const f = await parseTs(
      `function a() { throw new Error(); const x = 1; foo(); return 2; }`,
    );
    expect(unreachable(computeDeadCodeMetrics([f], idOf))).toBe(3);
  });

  it("counts code after break/continue inside a loop block", async () => {
    const f = await parseTs(`function a() { for (;;) { break; doStuff(); } }`);
    expect(unreachable(computeDeadCodeMetrics([f], idOf))).toBe(1);
  });

  it("does not flag reachable code (no terminal)", async () => {
    const f = await parseTs(`function a() { const x = 1; return x; }`);
    expect(computeDeadCodeMetrics([f], idOf)).toEqual([]);
  });

  it("does not flag code after a CONDITIONAL return (needs a plain terminal)", async () => {
    const f = await parseTs(`function a(x: number) { if (x) return 1; return 2; }`);
    expect(computeDeadCodeMetrics([f], idOf)).toEqual([]);
  });

  it("does not flag a hoisted function declaration after a return", async () => {
    const f = await parseTs(
      `function a() { return h(); function h() { return 1; } }`,
    );
    expect(computeDeadCodeMetrics([f], idOf)).toEqual([]);
  });

  it("does not treat switch fallthrough as unreachable", async () => {
    const f = await parseTs(
      `function a(x: number) { switch (x) { case 1: return 1; case 2: return 2; } }`,
    );
    expect(computeDeadCodeMetrics([f], idOf)).toEqual([]);
  });

  it("emits sparsely — no row when a file is clean", async () => {
    const f = await parseTs(`export const x = 1;\nexport function f() { return x; }\n`);
    expect(computeDeadCodeMetrics([f], idOf)).toEqual([]);
  });

  it("skips non-TypeScript files", async () => {
    const f = await parseFile(`def a():\n    return 1\n    x = 2\n`, "f.py", "python");
    expect(computeDeadCodeMetrics([f], idOf)).toEqual([]);
  });
});

describe("computeDeadCodeMetrics — unused params (C-65)", () => {
  it("counts a trailing unused parameter", async () => {
    const f = await parseTs(`function f(a: number, b: number) { return a; }`);
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_params")).toBe(1);
  });

  it("counts a whole trailing run of unused parameters", async () => {
    const f = await parseTs(`function f(a: number, b: number, c: number) { return 1; }`);
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_params")).toBe(3);
  });

  it("does NOT flag a middle unused parameter (can't drop it)", async () => {
    const f = await parseTs(`function f(a: number, b: number, c: number) { return a + c; }`);
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_params")).toBe(0);
  });

  it("counts a param used only inside a nested closure as used", async () => {
    const f = await parseTs(`function f(a: number) { return () => a; }`);
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_params")).toBe(0);
  });

  it("never flags `_`-prefixed parameters", async () => {
    const f = await parseTs(`function f(a: number, _b: number) { return a; }`);
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_params")).toBe(0);
  });

  it("never flags destructuring or rest parameters", async () => {
    const f = await parseTs(`function f(a: number, ...rest: number[]) { return a; }`);
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_params")).toBe(0);
    const g = await parseTs(`function g({ x }: { x: number }) { return 1; }`);
    expect(metric(computeDeadCodeMetrics([g], idOf), "unused_params")).toBe(0);
  });
});

describe("computeDeadCodeMetrics — unused locals (C-65)", () => {
  it("counts an unused local variable", async () => {
    const f = await parseTs(`function k() { const used = 1; const dead = 2; return used; }`);
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_locals")).toBe(1);
  });

  it("does not flag a local used in a nested closure", async () => {
    const f = await parseTs(`function k() { const x = 1; return () => x; }`);
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_locals")).toBe(0);
  });

  it("does not flag a shadowed name (declared twice)", async () => {
    const f = await parseTs(
      `function k() { const x = 1; function g() { const x = 2; return x; } return g(); }`,
    );
    // outer `x` is genuinely unused, but the redeclaration makes us skip it.
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_locals")).toBe(0);
  });

  it("does not flag destructuring locals", async () => {
    const f = await parseTs(`function k(o: { a: number }) { const { a } = o; return 1; }`);
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_locals")).toBe(0);
  });

  it("attributes a nested function's own unused local to that function", async () => {
    const f = await parseTs(
      `function outer() { return () => { const dead = 1; return 2; }; }`,
    );
    expect(metric(computeDeadCodeMetrics([f], idOf), "unused_locals")).toBe(1);
  });
});
