import { describe, it, expect } from "vitest";
import { parseFile, type ParsedFile } from "@titan-design/code-parser";
import { computeSourceMetrics } from "./source-metrics.js";
import { collectDeclaredNames } from "./declared-names.js";

const idOf = (p: string): string => p;

async function parseTs(code: string, filePath = "f.ts"): Promise<ParsedFile> {
  return parseFile(code, filePath, "typescript");
}

async function parsePy(code: string, filePath = "f.py"): Promise<ParsedFile> {
  return parseFile(code, filePath, "python");
}

function metric(
  metrics: ReturnType<typeof computeSourceMetrics>,
  nodeId: string,
  name: string,
): number | null | undefined {
  return metrics.find((m) => m.nodeId === nodeId && m.name === name)?.value;
}

describe("computeSourceMetrics — loc", () => {
  it("counts non-empty lines as loc", async () => {
    const file = await parseTs("const a = 1;\n\n  \nconst b = 2;\n");
    const metrics = computeSourceMetrics([file], idOf);
    expect(metric(metrics, "f.ts", "loc")).toBe(2);
  });

  it("includes loc on a file with no functions", async () => {
    const file = await parseTs("export const x = 42;\n");
    const metrics = computeSourceMetrics([file], idOf);
    expect(metric(metrics, "f.ts", "loc")).toBe(1);
    expect(metric(metrics, "f.ts", "function_count")).toBe(0);
    expect(metric(metrics, "f.ts", "cyclomatic_max")).toBeUndefined();
  });
});

describe("computeSourceMetrics — function_count", () => {
  it("counts function declarations and method definitions", async () => {
    const file = await parseTs(
      "function a() {}\nfunction b() {}\nclass C { m() {} }\n",
    );
    expect(metric(computeSourceMetrics([file], idOf), "f.ts", "function_count")).toBe(3);
  });

  it("counts python def statements", async () => {
    const file = await parsePy("def a():\n    pass\ndef b():\n    pass\n");
    expect(metric(computeSourceMetrics([file], idOf), "f.py", "function_count")).toBe(2);
  });
});

describe("computeSourceMetrics — cyclomatic", () => {
  it("returns base complexity 1 for a function with no branches", async () => {
    const file = await parseTs("function a() { return 1; }\n");
    const metrics = computeSourceMetrics([file], idOf);
    expect(metric(metrics, "f.ts", "cyclomatic_max")).toBe(1);
    expect(metric(metrics, "f.ts", "cyclomatic_sum")).toBe(1);
  });

  it("counts if + else-if + ternary + && as separate branches", async () => {
    const file = await parseTs(
      `function a(x: number) {
        if (x > 0) {
          if (x > 10 && x < 20) return 1;
        } else if (x < 0) {
          return -1;
        }
        return x > 5 ? "big" : "small";
      }\n`,
    );
    const metrics = computeSourceMetrics([file], idOf);
    // 1 base + if + nested if + && + (else-if = if) + ternary = 6
    expect(metric(metrics, "f.ts", "cyclomatic_max")).toBe(6);
  });

  it("aggregates max vs. sum across functions", async () => {
    const file = await parseTs(
      `function simple() { return 1; }
       function branchy(x: number) {
         if (x > 0) return 1;
         if (x < 0) return -1;
         return 0;
       }\n`,
    );
    const metrics = computeSourceMetrics([file], idOf);
    expect(metric(metrics, "f.ts", "cyclomatic_max")).toBe(3);
    expect(metric(metrics, "f.ts", "cyclomatic_sum")).toBe(4);
  });
});

describe("computeSourceMetrics — max_nesting_depth", () => {
  it("measures the deepest nesting across all functions in the file", async () => {
    const file = await parseTs(
      `function flat() { return 1; }
       function deep() {
         if (true) {
           for (let i = 0; i < 10; i++) {
             while (i > 0) {
               i--;
             }
           }
         }
       }\n`,
    );
    expect(
      metric(computeSourceMetrics([file], idOf), "f.ts", "max_nesting_depth"),
    ).toBe(3);
  });
});

describe("computeSourceMetrics — id mapping", () => {
  it("uses the supplied fileIdOf to key the metrics", async () => {
    const file = await parseTs("export const x = 1;\n", "/abs/path/foo.ts");
    const metrics = computeSourceMetrics([file], (p) =>
      p.replace("/abs/path/", "rel/"),
    );
    const ids = new Set(metrics.map((m) => m.nodeId));
    expect(ids).toEqual(new Set(["rel/foo.ts"]));
  });
});

describe("computeSourceMetrics — arrow/expr functions bound to a name (C-58)", () => {
  it("counts arrow and function-expression bindings that were previously invisible", async () => {
    const file = await parseTs(
      `export const arrow = (x: number) => { if (x > 0) return 1; return 0; };
       export const expr = function (y: number) { if (y) return y; return 0; };
       function decl() { return 1; }\n`,
    );
    const metrics = computeSourceMetrics([file], idOf);
    // All three are named functions now (arrow + fn-expr + decl).
    expect(metric(metrics, "f.ts", "function_count")).toBe(3);
    // The branchy arrow/expr drive cyclomatic_max above the plain decl's 1.
    expect(metric(metrics, "f.ts", "cyclomatic_max")).toBe(2);
  });

  it("does NOT count anonymous inline callbacks as standalone functions", async () => {
    const file = await parseTs(
      `function run(xs: number[]) { return xs.map((x) => x + 1).filter((x) => x > 0); }\n`,
    );
    // Only `run` — the two inline arrows are callbacks, not named bindings.
    expect(metric(computeSourceMetrics([file], idOf), "f.ts", "function_count")).toBe(1);
  });
});

describe("computeSourceMetrics — per-symbol complexity (C-58)", () => {
  const sym = (file: string, name: string): string => `${file}#${name}`;

  it("emits symbol_cognitive/symbol_cyclomatic for exported functions only", async () => {
    const file = await parseTs(
      `export function hot(x: number) {
         if (x > 0) { if (x > 10 && x < 20) return 1; }
         return x > 5 ? 1 : 0;
       }
       function internalHelper(y: number) { if (y) return y; return 0; }\n`,
    );
    const names = new Map([["f.ts", new Set(["hot"])]]);
    const metrics = computeSourceMetrics([file], idOf, names);
    expect(metric(metrics, sym("f.ts", "hot"), "symbol_cognitive")).toBeGreaterThan(0);
    expect(metric(metrics, sym("f.ts", "hot"), "symbol_cyclomatic")).toBeGreaterThan(1);
    // The non-exported helper has no symbol node → no per-symbol metric.
    expect(metric(metrics, sym("f.ts", "internalHelper"), "symbol_cognitive")).toBeUndefined();
    // File-level metrics still count BOTH functions.
    expect(metric(metrics, "f.ts", "function_count")).toBe(2);
  });

  it("attributes complexity to an exported const-arrow export", async () => {
    const file = await parseTs(
      `export const handler = (n: number) => {
         if (n > 0 && n < 10) { for (let i = 0; i < n; i++) { if (i) return i; } }
         return 0;
       };\n`,
    );
    const names = new Map([["f.ts", new Set(["handler"])]]);
    const metrics = computeSourceMetrics([file], idOf, names);
    // The whole point of C-58: this arrow-const export gets its own complexity.
    expect(metric(metrics, sym("f.ts", "handler"), "symbol_cognitive")).toBeGreaterThan(0);
  });

  it("takes the max when a name maps to several functions", async () => {
    // Since TP-182 a method is `A.dup`, so only an accessor pair still shares one qualified name.
    const file = await parseTs(
      `class A {
         set v(x: number) { if (x > 0) { if (x > 1) { if (x > 2) return; } } }
         get v(): number { return 0; }
       }\n`,
    );
    const names = new Map([["f.ts", new Set(["A.v"])]]);
    const metrics = computeSourceMetrics([file], idOf, names);
    // The setter's nested ifs (1 + 2 + 3) dominate the getter's 0.
    expect(metric(metrics, sym("f.ts", "A.v"), "symbol_cognitive")).toBe(6);
  });

  it("emits nothing per-symbol when no symbol names are supplied", async () => {
    const file = await parseTs(`export function a() { if (1) return 1; return 0; }\n`);
    const metrics = computeSourceMetrics([file], idOf);
    expect(metrics.some((m) => m.name === "symbol_cognitive")).toBe(false);
  });

  it("ignores an anonymous default export without crashing", async () => {
    const file = await parseTs(`export default function () { if (1) return 1; return 0; }\n`);
    const names = new Map([["f.ts", new Set(["default"])]]);
    const metrics = computeSourceMetrics([file], idOf, names);
    // Anonymous — no name to match "default", so no symbol metric, no throw.
    expect(metrics.some((m) => m.name === "symbol_cognitive")).toBe(false);
  });
});

describe("collectDeclaredNames + internal-symbol complexity (C-64)", () => {
  const sym = (file: string, name: string): string => `${file}#${name}`;

  it("collects functions, methods, classes, and arrow-consts — not plain consts", async () => {
    const file = await parseTs(
      `export function pub() {}\n` +
        `function helper() {}\n` +
        `const arrow = () => 1;\n` +
        `const CONST = 42;\n` +
        `class Priv { run() {} }\n`,
    );
    // Methods carry their class scope since TP-182.
    expect([...collectDeclaredNames(file)].sort()).toEqual([
      "Priv",
      "Priv.run",
      "arrow",
      "helper",
      "pub",
    ]);
  });

  it("emits per-symbol complexity for a non-exported function once model B gives it a node", async () => {
    const file = await parseTs(
      `export function pub(x: number) { return x; }\n` +
        `function helper(n: number) { let s = 0; for (let i = 0; i < n; i++) { if (i % 2) s += i; } return s; }\n`,
    );
    // Model B (C-64) supplies BOTH names — internal helpers now have symbol nodes.
    const names = new Map([["f.ts", new Set(["pub", "helper"])]]);
    const metrics = computeSourceMetrics([file], idOf, names);
    expect(metric(metrics, sym("f.ts", "helper"), "symbol_cyclomatic")).toBeGreaterThan(1);
    expect(metric(metrics, sym("f.ts", "pub"), "symbol_cyclomatic")).toBe(1);
  });

  it("collects python defs and classes", async () => {
    const file = await parsePy(
      `def a():\n    pass\nclass B:\n    def m(self):\n        pass\n`,
    );
    // Methods carry their class scope since TP-182.
    expect([...collectDeclaredNames(file)].sort()).toEqual(["B", "B.m", "a"]);
  });
});

describe("computeSourceMetrics — per-symbol loc and nesting (TP-317)", () => {
  const sym = (file: string, name: string): string => `${file}#${name}`;

  it("reports each TypeScript function's line span and nesting on its own symbol", async () => {
    const file = await parseTs(
      [
        "export function flat(x: number) {",
        "  return x;",
        "}",
        "export function deep(xs: number[]) {",
        "  for (const x of xs) {",
        "    if (x > 0) {",
        "      while (x) {",
        "        return x;",
        "      }",
        "    }",
        "  }",
        "  return 0;",
        "}",
      ].join("\n"),
    );
    const names = new Map([["f.ts", new Set(["flat", "deep"])]]);
    const metrics = computeSourceMetrics([file], idOf, names);
    expect(metric(metrics, sym("f.ts", "flat"), "symbol_loc")).toBe(3);
    expect(metric(metrics, sym("f.ts", "flat"), "symbol_max_nesting")).toBe(0);
    expect(metric(metrics, sym("f.ts", "deep"), "symbol_loc")).toBe(10);
    expect(metric(metrics, sym("f.ts", "deep"), "symbol_max_nesting")).toBe(3);
  });

  it("reports each Python function's line span and nesting on its own symbol", async () => {
    const file = await parsePy(
      [
        "def short(x):",
        "    return x",
        "",
        "class Job:",
        "    def run(self, xs):",
        "        for x in xs:",
        "            if x:",
        "                return x",
        "        return None",
      ].join("\n"),
    );
    const names = new Map([["f.py", new Set(["short", "Job", "Job.run"])]]);
    const metrics = computeSourceMetrics([file], idOf, names);
    expect(metric(metrics, sym("f.py", "short"), "symbol_loc")).toBe(2);
    expect(metric(metrics, sym("f.py", "short"), "symbol_max_nesting")).toBe(0);
    expect(metric(metrics, sym("f.py", "Job.run"), "symbol_loc")).toBe(5);
    expect(metric(metrics, sym("f.py", "Job.run"), "symbol_max_nesting")).toBe(2);
    expect(metric(metrics, sym("f.py", "Job"), "symbol_loc")).toBeUndefined();
  });

  it("takes the max of loc and nesting independently when a name maps to several functions", async () => {
    const file = await parseTs(
      [
        "class A {",
        "  set v(x: number) { if (x) { if (x > 1) return; } }",
        "  get v(): number {",
        "    const a = 1;",
        "    return a;",
        "  }",
        "}",
      ].join("\n"),
    );
    const names = new Map([["f.ts", new Set(["A.v"])]]);
    const metrics = computeSourceMetrics([file], idOf, names);
    expect(metric(metrics, sym("f.ts", "A.v"), "symbol_loc")).toBe(4);
    expect(metric(metrics, sym("f.ts", "A.v"), "symbol_max_nesting")).toBe(2);
  });
});
