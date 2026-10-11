import { describe, expect, it } from "vitest";
import { parseFile, type ParsedFile } from "@titan-design/code-parser";
import { collectDeclarations } from "./declared-names.js";
import { digestParsedFile } from "./file-digest.js";
import { assembleIndexerMetrics } from "./index-metrics.js";
import { fileId, symbolId } from "./extractors/ids.js";
import { qualifiedSymbolAliases } from "./symbol-aliases.js";
import type { GraphNode } from "./types.js";

const ID_ROOT = "/repo";

const A_TS = `export function walk(rows: number[][]): number {
  let total = 0;
  const unused = 1;
  for (const row of rows) {
    for (const cell of row) {
      if ([1, 2].includes(cell)) total += cell;
    }
  }
  return total;
}

export function fact(n: number): number {
  return n <= 1 ? 1 : n * fact(n - 1);
}

export class Job {
  run(): void {}
}
`;

const B_PY = `class Worker:
    def run(self, items):
        for item in items:
            if item:
                return item
        return None


def helper(x):
    return x + 1
`;

async function parseFixture(): Promise<ParsedFile[]> {
  return [
    await parseFile(A_TS, `${ID_ROOT}/src/a.ts`, "typescript"),
    await parseFile(B_PY, `${ID_ROOT}/src/b.py`, "python"),
  ];
}

function declaredNames(file: ParsedFile): Set<string> {
  return new Set(collectDeclarations(file).map((d) => d.qualifiedName));
}

function nodesFor(files: readonly ParsedFile[], skip: ReadonlySet<string> = new Set()): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const file of files) {
    const id = fileId(ID_ROOT, file.filePath);
    nodes.set(id, { id, kind: "file", name: id });
    for (const name of declaredNames(file)) {
      const sid = symbolId(id, name);
      if (!skip.has(sid)) nodes.set(sid, { id: sid, kind: "symbol", name, parentId: id });
    }
  }
  return nodes;
}

function digestAll(files: readonly ParsedFile[]) {
  return files.map((f) => digestParsedFile(f, fileId(ID_ROOT, f.filePath), declaredNames(f)));
}

function assemble(nodes: Map<string, GraphNode>, source: { parsedFiles: ParsedFile[] } | { fileDigests: ReturnType<typeof digestAll> }) {
  return assembleIndexerMetrics({ nodes, edges: new Map(), reusedSourceMetrics: [], idRoot: ID_ROOT, ...source }).metrics;
}

describe("metrics assembled from file digests", () => {
  it("equal the metrics computed from parsed files, in content and order", async () => {
    const files = await parseFixture();
    const nodes = nodesFor(files);

    const fromParsed = assemble(nodes, { parsedFiles: files });
    const fromDigests = assemble(nodes, { fileDigests: digestAll(files) });

    expect(fromDigests).toEqual(fromParsed);
    expect(fromParsed.some((m) => m.nodeId === "src/a.ts#walk")).toBe(true);
    expect(fromParsed.some((m) => m.name === "loop_depth")).toBe(true);
  });

  it("drop a symbol metric whose node was pruned from the final node map", async () => {
    const files = await parseFixture();
    const pruned = "src/a.ts#fact";
    const nodes = nodesFor(files, new Set([pruned]));

    const fromDigests = assemble(nodes, { fileDigests: digestAll(files) });

    expect(digestAll(files)[0]!.sourceMetrics.some((m) => m.nodeId === pruned)).toBe(true);
    expect(fromDigests.some((m) => m.nodeId === pruned)).toBe(false);
    expect(fromDigests).toEqual(assemble(nodes, { parsedFiles: files }));
  });
});

describe("qualifiedSymbolAliases from digests", () => {
  it("matches the aliases computed from parsed files", async () => {
    const files = await parseFixture();
    const nodeIds = new Set(nodesFor(files).keys());

    const fromParsed = qualifiedSymbolAliases(
      files.map((file) => ({ fileId: fileId(ID_ROOT, file.filePath), file })),
      nodeIds,
    );
    const fromDigests = qualifiedSymbolAliases(digestAll(files), nodeIds);

    expect(fromDigests).toEqual(fromParsed);
    expect(fromParsed).toContainEqual({ oldId: "src/b.py#run", newId: "src/b.py#Worker.run", reason: "requalify" });
  });
});
