import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = new URL("../", import.meta.url);
const TRACE = new URL("./", import.meta.url);
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const importsOf = (file: URL) => [...readFileSync(file, "utf8").matchAll(IMPORT)].map((match) => match[1]!);

function rootEntryGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = ["index.ts"];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (graph.has(file)) continue;
    const imports = importsOf(new URL(file, SRC));
    graph.set(file, imports);
    for (const spec of imports) if (spec.startsWith("./")) pending.push(spec.slice(2).replace(/\.js$/, ".ts"));
  }
  return graph;
}

describe("trace subpath packaging", () => {
  it("ships no Node-only import from the trace source", () => {
    const shipped = readdirSync(TRACE).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(shipped).toContain("index.ts");
    for (const name of shipped) expect(importsOf(new URL(name, TRACE)).filter((spec) => spec.startsWith("node:")), name).toEqual([]);
  });

  it("keeps zod and the trace subpath out of the root entry's import graph", () => {
    const graph = rootEntryGraph();
    expect(graph.size).toBeGreaterThan(1);
    for (const [file, imports] of graph) {
      expect(imports.filter((spec) => spec === "zod" || spec.includes("trace")), file).toEqual([]);
    }
  });
});
