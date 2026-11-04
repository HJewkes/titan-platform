import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

export type ImportGraph = Map<string, Set<string>>;

const SRC = new URL("..", import.meta.url).pathname;
const IMPORT = /(?:import|export)\s+(type\s+)?[^'";]*?from\s+['"](\.[^'"]+)['"]/gs;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function resolveTarget(from: string, specifier: string, files: Set<string>): string | undefined {
  const base = normalize(join(dirname(from), specifier)).replace(/\.js$/, "");
  return [`${base}.ts`, join(base, "index.ts")].find((candidate) => files.has(candidate));
}

/** The relative-import graph of every non-test source file under `src`, keyed by path relative to `src`; `valueOnly` drops `import type` and `export type` edges. */
export function importGraph(options: { valueOnly: boolean }): ImportGraph {
  const files = new Set(sourceFiles(SRC));
  const graph: ImportGraph = new Map();
  for (const file of files) {
    const edges = new Set<string>();
    for (const [, typeOnly, specifier] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const target = resolveTarget(file, specifier!, files);
      if (target && !(options.valueOnly && typeOnly)) edges.add(relative(SRC, target));
    }
    graph.set(relative(SRC, file), edges);
  }
  return graph;
}
