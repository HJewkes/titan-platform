import { describe, it, expect } from "vitest";
import { parseFile, type ParsedFile } from "@titan-design/code-parser";
import { computeLcomMetrics } from "./lcom.js";

const idOf = (p: string): string => p;

async function parseTs(code: string, p = "f.ts"): Promise<ParsedFile> {
  return parseFile(code, p, "typescript");
}

async function parsePy(code: string, p = "f.py"): Promise<ParsedFile> {
  return parseFile(code, p, "python");
}

function metric(
  metrics: ReturnType<typeof computeLcomMetrics>,
  name: string,
): number | null | undefined {
  return metrics.find((m) => m.name === name)?.value;
}

describe("computeLcomMetrics (TypeScript)", () => {
  it("emits no metrics for a file with no classes", async () => {
    const file = await parseTs("function f() { return 1; }\n");
    expect(computeLcomMetrics(file, idOf("f.ts"))).toEqual([]);
  });

  it("LCOM4=1 when every method shares the same field", async () => {
    const file = await parseTs(
      [
        "class C {",
        "  x = 0;",
        "  a() { return this.x; }",
        "  b() { this.x = 1; }",
        "  c() { return this.x + 1; }",
        "}",
      ].join("\n"),
    );
    const m = computeLcomMetrics(file, "f.ts");
    expect(metric(m, "class_count")).toBe(1);
    expect(metric(m, "lcom4_max")).toBe(1);
  });

  it("LCOM4=2 when methods split into two disjoint groups", async () => {
    const file = await parseTs(
      [
        "class Split {",
        "  a() { return this.x; }",
        "  b() { this.x += 1; }",
        "  c() { return this.y; }",
        "  d() { this.y = 2; }",
        "}",
      ].join("\n"),
    );
    expect(metric(computeLcomMetrics(file, "f.ts"), "lcom4_max")).toBe(2);
  });

  it("LCOM4=1 when one method calls another (chains components)", async () => {
    const file = await parseTs(
      [
        "class Chain {",
        "  a() { return this.b(); }",
        "  b() { return this.x; }",
        "  c() { return this.x + 1; }",
        "}",
      ].join("\n"),
    );
    expect(metric(computeLcomMetrics(file, "f.ts"), "lcom4_max")).toBe(1);
  });

  it("LCOM4=N for N fully independent methods", async () => {
    const file = await parseTs(
      [
        "class Lonely {",
        "  a() { return 1; }",
        "  b() { return 2; }",
        "  c() { return 3; }",
        "}",
      ].join("\n"),
    );
    expect(metric(computeLcomMetrics(file, "f.ts"), "lcom4_max")).toBe(3);
  });

  it("ignores the constructor and static methods", async () => {
    const file = await parseTs(
      [
        "class C {",
        "  constructor(public x: number) {}",
        "  static u() { return 1; }",
        "  a() { return this.x; }",
        "  b() { return this.x; }",
        "}",
      ].join("\n"),
    );
    const m = computeLcomMetrics(file, "f.ts");
    expect(metric(m, "lcom4_max")).toBe(1); // a + b share x; constructor/static skipped
  });

  it("emits the max LCOM4 across multiple classes", async () => {
    const file = await parseTs(
      [
        "class Cohesive {",
        "  x = 0;",
        "  a() { return this.x; }",
        "  b() { return this.x; }",
        "}",
        "class Loose {",
        "  a() { return 1; }",
        "  b() { return 2; }",
        "}",
      ].join("\n"),
    );
    const m = computeLcomMetrics(file, "f.ts");
    expect(metric(m, "class_count")).toBe(2);
    expect(metric(m, "lcom4_max")).toBe(2);
  });

  it("returns lcom4=1 for a class with a single method", async () => {
    const file = await parseTs("class One { a() { return 1; } }\n");
    expect(metric(computeLcomMetrics(file, "f.ts"), "lcom4_max")).toBe(1);
  });

  it("omits lcom4_max when classes are constructor-only", async () => {
    const file = await parseTs("class Empty { constructor() {} }\n");
    const m = computeLcomMetrics(file, "f.ts");
    expect(metric(m, "class_count")).toBe(1);
    expect(metric(m, "lcom4_max")).toBeUndefined();
  });
});

describe("computeLcomMetrics (Python)", () => {
  it("treats self.<x> like this.<x>", async () => {
    const file = await parsePy(
      [
        "class C:",
        "    def a(self):",
        "        return self.x",
        "    def b(self):",
        "        self.x = 1",
        "    def c(self):",
        "        return self.y",
        "",
      ].join("\n"),
    );
    expect(metric(computeLcomMetrics(file, "f.py"), "lcom4_max")).toBe(2);
  });

  it("skips __init__, @staticmethod, and @classmethod", async () => {
    const file = await parsePy(
      [
        "class C:",
        "    def __init__(self):",
        "        self.x = 0",
        "    @staticmethod",
        "    def s():",
        "        return 1",
        "    @classmethod",
        "    def c(cls):",
        "        return 2",
        "    def a(self):",
        "        return self.x",
        "    def b(self):",
        "        return self.x",
        "",
      ].join("\n"),
    );
    expect(metric(computeLcomMetrics(file, "f.py"), "lcom4_max")).toBe(1);
  });
});
