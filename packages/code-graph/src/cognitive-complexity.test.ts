import { describe, it, expect } from "vitest";
import { parseFile, type ParsedFile } from "@titan-design/code-parser";
import { cognitiveComplexityOf, cognitiveSplitOf } from "./cognitive-complexity.js";
import { collectDeclaredNames } from "./declared-names.js";
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

  it("charges nesting for an if inside a nested function expression (TP-1229)", async () => {
    const file = await parseTs(`function f(x: number) { return function () { if (x > 0) return 1; }; }`);
    const metrics = computeSourceMetrics([file], idOf);
    expect(score(metrics)).toBe(2);
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

const MARKUP_ONLY = `export function Card({ open, kind }) {
  return <div>{open && <Body />}{kind === "a" ? <A /> : <B />}</div>;
}`;
const HOOK_CALLBACK = `export function Timer({ on }) {
  useEffect(() => { if (on) start(); }, [on]);
  return <div />;
}`;
const INLINE_HANDLER = `export function Go({ x }) {
  return <button onClick={() => { if (x) go(); }}>Go</button>;
}`;

/** The shapes scored above, in both languages, plus the JSX components: [code, language, path]. */
const SPLIT_FIXTURES: readonly [string, string, string][] = [
  ["function f(x: number, y: number) { if (x > 0) { if (y > 0) return 1; } }", "typescript", "f.ts"],
  ["function f(x: number) { if (x === 1) return 1; else if (x === 2) return 2; else return 0; }", "typescript", "f.ts"],
  ["function f(a: boolean, b: boolean, c: boolean) { if (a && b || c) return 1; }", "typescript", "f.ts"],
  ["function f(x: number) { switch (x) { case 1: return 1; default: return 0; } }", "typescript", "f.ts"],
  ["function f(xs: number[]) { if (xs.length) { for (const x of xs) { if (x) return x; } } }", "typescript", "f.ts"],
  ["function f(x: number) { return function () { if (x > 0) return 1; }; }", "typescript", "f.ts"],
  ["def f(a, b, c):\n    if a and b or c:\n        return 1\n    elif a:\n        return 2\n", "python", "f.py"],
  [MARKUP_ONLY, "typescript", "C.tsx"],
  [HOOK_CALLBACK, "typescript", "C.tsx"],
  [INLINE_HANDLER, "typescript", "C.tsx"],
  ["export const L = ({ rows }) => <ul>{rows.map((r) => (r.ok ? <Ok key={r.id} /> : null))}</ul>;", "typescript", "C.tsx"],
];

async function symbolMetricsOf(code: string, filePath = "C.tsx"): Promise<ReturnType<typeof computeSourceMetrics>> {
  const file = await parseTs(code, filePath);
  return computeSourceMetrics([file], idOf, new Map([[filePath, collectDeclaredNames(file)]]));
}

function metricOf(metrics: ReturnType<typeof computeSourceMetrics>, nodeId: string, name: string): number | undefined {
  return metrics.find((m) => m.nodeId === nodeId && m.name === name)?.value ?? undefined;
}

describe("cognitive complexity — logic versus markup (C-97 S2)", () => {
  it("logic plus markup equals cognitive for every fixture", async () => {
    for (const [code, language, filePath] of SPLIT_FIXTURES) {
      const file = await parseFile(code, filePath, language);
      const root = file.tree.rootNode;
      const metrics = computeSourceMetrics([file], idOf, new Map([[filePath, collectDeclaredNames(file)]]));

      expect(cognitiveSplitOf(root, language).total).toBe(cognitiveComplexityOf(root, language));
      for (const logic of metrics.filter((m) => m.name === "symbol_logic_cognitive")) {
        const markup = metricOf(metrics, logic.nodeId, "symbol_markup_cognitive");
        expect(logic.value! + markup!).toBe(metricOf(metrics, logic.nodeId, "symbol_cognitive"));
      }
    }
  });

  it("scores a markup-only component's conditionals as markup, leaving logic 0", async () => {
    const metrics = await symbolMetricsOf(MARKUP_ONLY);

    expect(metricOf(metrics, "C.tsx#Card", "symbol_cognitive")).toBe(2);
    expect(metricOf(metrics, "C.tsx#Card", "symbol_markup_cognitive")).toBe(2);
    expect(metricOf(metrics, "C.tsx#Card", "symbol_logic_cognitive")).toBe(0);
    expect(metricOf(metrics, "C.tsx", "logic_cognitive_max")).toBe(0);
  });

  it("keeps a useEffect callback's complexity in logic", async () => {
    const metrics = await symbolMetricsOf(HOOK_CALLBACK);

    expect(metricOf(metrics, "C.tsx#Timer", "symbol_logic_cognitive")).toBe(2);
    expect(metricOf(metrics, "C.tsx#Timer", "symbol_markup_cognitive")).toBe(0);
    expect(metricOf(metrics, "C.tsx", "logic_cognitive_max")).toBe(2);
  });

  it("counts an if inside an inline onClick arrow as markup", async () => {
    const metrics = await symbolMetricsOf(INLINE_HANDLER);

    expect(metricOf(metrics, "C.tsx#Go", "symbol_markup_cognitive")).toBe(2);
    expect(metricOf(metrics, "C.tsx#Go", "symbol_logic_cognitive")).toBe(0);
  });

  it("writes no logic or markup metrics for a function that renders no JSX", async () => {
    const metrics = await symbolMetricsOf("export function f(x: number) { if (x) return 1; }", "f.ts");

    expect(metrics.some((m) => /logic_cognitive|markup_cognitive/.test(m.name))).toBe(false);
  });
});
