import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../types.js";
import {
  DEFAULT_MAX_LINE_CHARS,
  ELISION_MARKER,
  TRUNCATION_SUFFIX,
  renderSignatureTree,
} from "./signature-tree.js";

function sym(
  file: string,
  name: string,
  attrs: Record<string, unknown>,
): GraphNode {
  return { id: `${file}#${name}`, kind: "symbol", name, parentId: file, attrs };
}

const fixture: GraphNode[] = [
  sym("src/b.ts", "later", { signature: "function later(): void", startLine: 30, endLine: 35 }),
  sym("src/b.ts", "first", { signature: "function first(): void", startLine: 1, endLine: 5 }),
  sym("src/a.ts", "Job", { signature: "class Job", startLine: 1, endLine: 10 }),
  sym("src/a.ts", "Job.run", { signature: "run(): void", startLine: 2, endLine: 4 }),
  sym("src/a.ts", "next", { signature: "function next(): void", startLine: 11, endLine: 12 }),
  sym("src/a.ts", "Opts", { signature: "type Opts = {}", exported: true }),
];

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe("renderSignatureTree", () => {
  it("emits a sorted file header then one line per symbol in line order", () => {
    const out = renderSignatureTree(fixture).split("\n");
    expect(out[0]).toBe("src/a.ts");
    expect(out.slice(1, 4)).toEqual(["class Job", "  run(): void", "function next(): void"]);
    expect(out).toContain("src/b.ts");
    expect(out.indexOf("src/b.ts")).toBeGreaterThan(out.indexOf("function next(): void"));
  });

  it("puts an elision marker between non-adjacent symbols only", () => {
    const out = renderSignatureTree(fixture).split("\n");
    const b = out.slice(out.indexOf("src/b.ts"));
    expect(b).toEqual(["src/b.ts", "function first(): void", ELISION_MARKER, "function later(): void"]);
    expect(out.slice(0, out.indexOf("src/b.ts")).includes(ELISION_MARKER)).toBe(false);
  });

  it("truncates a long signature and a long header within maxLineChars", () => {
    const long = "x".repeat(50);
    const nodes = [sym(`${long}.ts`, "f", { signature: `function f(${long})`, startLine: 1, endLine: 2 })];
    const lines = renderSignatureTree(nodes, { maxLineChars: 20 }).split("\n");
    expect(lines.map((l) => l.length)).toEqual([20, 20]);
    expect(lines.every((l) => l.endsWith(TRUNCATION_SUFFIX))).toBe(true);
  });

  it("does not truncate a line that fits the default limit", () => {
    const sig = "y".repeat(DEFAULT_MAX_LINE_CHARS);
    const nodes = [sym("a.ts", "f", { signature: sig, startLine: 1 })];
    expect(renderSignatureTree(nodes)).toBe(`a.ts\n${sig}`);
  });

  it("renders byte-identical output for shuffled input, including equal start lines", () => {
    const ties = [
      ...fixture,
      sym("src/a.ts", "twinB", { startLine: 20, endLine: 21 }),
      sym("src/a.ts", "twinA", { startLine: 20, endLine: 21 }),
    ];
    const expected = renderSignatureTree(ties);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      expect(renderSignatureTree(shuffled(ties, seed))).toBe(expected);
    }
  });

  it("falls back to `<name> (<kind>)` for a node with no signature", () => {
    const nodes = [sym("a.ts", "bare", { startLine: 1, endLine: 2 })];
    expect(renderSignatureTree(nodes)).toBe("a.ts\nbare (symbol)");
  });

  it("renders symbols with no startLine after the line-ordered ones, by name, with no marker", () => {
    const nodes = [
      sym("a.ts", "Zed", { signature: "type Zed = 1" }),
      sym("a.ts", "Alpha", { signature: "type Alpha = 1" }),
      sym("a.ts", "fn", { signature: "function fn(): void", startLine: 50, endLine: 60 }),
    ];
    expect(renderSignatureTree(nodes).split("\n")).toEqual([
      "a.ts",
      "function fn(): void",
      "type Alpha = 1",
      "type Zed = 1",
    ]);
  });

  it("derives the file from the id when parentId is absent", () => {
    const node: GraphNode = { id: "m.ts#f", kind: "symbol", name: "f", attrs: { startLine: 1 } };
    expect(renderSignatureTree([node])).toBe("m.ts\nf (symbol)");
  });
});
