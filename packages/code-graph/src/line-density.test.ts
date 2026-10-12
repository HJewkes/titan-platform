import { describe, it, expect } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { lineDensityMetrics } from "./line-density.js";
import { computeSourceMetrics } from "./source-metrics.js";

async function densityOf(code: string, language: "typescript" | "python" = "typescript"): Promise<Map<string, number>> {
  const file = await parseFile(code, language === "python" ? "f.py" : "f.ts", language);
  const rows = lineDensityMetrics("f", file.content, file.tree.rootNode);
  return new Map(rows.map((r) => [r.name, r.value ?? Number.NaN]));
}

describe("lineDensityMetrics", () => {
  it("scores one line over 160 chars among 10 non-blank lines as a 0.1 long-line share", async () => {
    const long = `const s = "${"x".repeat(156)}";`;
    const code = [long, ...Array.from({ length: 9 }, (_, i) => `const v${i} = ${i};`), "", "  "].join("\n");

    const density = await densityOf(code);

    expect(long.length).toBeGreaterThan(160);
    expect(density.get("long_line_share_160")).toBe(0.1);
  });

  it("does not count a line of exactly 160 chars as long", async () => {
    const line = `const s = "${"x".repeat(160 - 13)}";`;

    const density = await densityOf(line);

    expect(line.length).toBe(160);
    expect(density.get("long_line_share_160")).toBe(0);
  });

  it("measures chars per non-blank line without indentation", async () => {
    const density = await densityOf("if (a) {\n    b();\n}\n\n");

    expect(density.get("chars_per_sloc")).toBe((8 + 4 + 1) / 3);
  });

  it("counts &&, ||, ?? and ternaries per line but not operators inside strings or comments", async () => {
    const code = [
      "const a = x && y || z;",
      "const b = p ?? (q ? 1 : 2);",
      'const c = "a && b || c";',
      "// d && e",
    ].join("\n");

    const density = await densityOf(code);

    expect(density.get("bool_ops_per_line")).toBe(4 / 4);
  });

  it("ignores non-boolean binary operators", async () => {
    const density = await densityOf("const a = 1 + 2 * 3 & 4 | 5;");

    expect(density.get("bool_ops_per_line")).toBe(0);
  });

  it("counts Python and, or and conditional expressions", async () => {
    const density = await densityOf("a = x and y or z\nb = 1 if a else 2\n", "python");

    expect(density.get("bool_ops_per_line")).toBe(3 / 2);
  });

  it("writes zeros for an empty file", async () => {
    const density = await densityOf("\n\n");

    expect([...density.values()]).toEqual([0, 0, 0]);
  });

  it("is part of every file's source metrics", async () => {
    const file = await parseFile("const a = x && y;\n", "f.ts", "typescript");

    const metrics = computeSourceMetrics([file], (p) => p);

    expect(metrics.find((m) => m.nodeId === "f.ts" && m.name === "bool_ops_per_line")?.value).toBe(1);
  });
});
