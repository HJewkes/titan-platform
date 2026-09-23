import { describe, expect, it } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { computeSourceMetrics } from "../source-metrics.js";

const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

async function symbolMetric(code: string, lang: "typescript" | "python", name: string, metric: string): Promise<number | undefined> {
  const fp = lang === "python" ? "f.py" : "f.ts";
  const file = await parseFile(code, fp, lang);
  const metrics = computeSourceMetrics([file], (p) => p, new Map([[fp, new Set([name])]]));
  return metrics.find((m) => m.nodeId === `${fp}#${name}` && m.name === metric)?.value ?? undefined;
}

describe("symbol comment, docstring and body lines on TypeScript (TP-322)", () => {
  const code = lines(
    "/**",
    " * Sums the values.",
    " */",
    "export function total(xs: number[]): number {",
    "  // start from zero",
    "  let sum = 0;",
    "",
    "  /* walk every value",
    "     and add it */",
    "  for (const x of xs) sum += x; // accumulate",
    "  return sum;",
    "}",
  );

  it("counts each row holding a comment once, trailing comments included", async () => {
    expect(await symbolMetric(code, "typescript", "total", "symbol_comment_lines")).toBe(4);
  });

  it("counts the attached JSDoc block as docstring lines, not comment lines", async () => {
    expect(await symbolMetric(code, "typescript", "total", "symbol_docstring_lines")).toBe(3);
  });

  it("counts non-blank rows that hold code, a row with code and a trailing comment included", async () => {
    expect(await symbolMetric(code, "typescript", "total", "symbol_body_lines")).toBe(3);
  });

  it("divides comment lines by body lines", async () => {
    expect(await symbolMetric(code, "typescript", "total", "symbol_comment_ratio")).toBeCloseTo(4 / 3);
  });

  it("does not attach a JSDoc block separated from the declaration by a blank line", async () => {
    const detached = lines("/** file header */", "", "function f() {", "  return 1;", "}");
    expect(await symbolMetric(detached, "typescript", "f", "symbol_docstring_lines")).toBe(0);
  });

  it("attaches a JSDoc block to a const-bound arrow function", async () => {
    const arrow = lines("/** Doubles. */", "export const double = (n: number) => n * 2;");
    expect(await symbolMetric(arrow, "typescript", "double", "symbol_docstring_lines")).toBe(1);
    expect(await symbolMetric(arrow, "typescript", "double", "symbol_body_lines")).toBe(1);
  });

  it("reports a ratio of zero for a function with no comments", async () => {
    const plain = lines("function f() {", "  return 1;", "}");
    expect(await symbolMetric(plain, "typescript", "f", "symbol_comment_ratio")).toBe(0);
  });
});

describe("symbol comment, docstring and body lines on Python (TP-322)", () => {
  const code = lines(
    "def total(xs):",
    '    """Sum the values.',
    "",
    "    Returns zero for an empty list.",
    '    """',
    "    # start from zero",
    "    acc = 0",
    "    for x in xs:",
    "        acc += x  # accumulate",
    "    return acc",
  );

  it("counts the docstring's rows as docstring lines", async () => {
    expect(await symbolMetric(code, "python", "total", "symbol_docstring_lines")).toBe(4);
  });

  it("keeps the docstring out of comment and body lines", async () => {
    expect(await symbolMetric(code, "python", "total", "symbol_comment_lines")).toBe(2);
    expect(await symbolMetric(code, "python", "total", "symbol_body_lines")).toBe(4);
  });

  it("treats a string that is not the first statement as code, not a docstring", async () => {
    const late = lines("def f():", "    x = 1", '    "not a docstring"', "    return x");
    expect(await symbolMetric(late, "python", "f", "symbol_docstring_lines")).toBe(0);
    expect(await symbolMetric(late, "python", "f", "symbol_body_lines")).toBe(3);
  });

  it("gives a method its own counts under its qualified name", async () => {
    const cls = lines("class Job:", "    def run(self):", "        # go", "        return 1");
    expect(await symbolMetric(cls, "python", "Job.run", "symbol_comment_ratio")).toBe(1);
  });
});
