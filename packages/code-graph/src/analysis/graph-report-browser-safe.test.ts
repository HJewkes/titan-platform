import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The static report app runs these derivations in a browser, so their whole relative
// import closure may reach no package and no Node builtin.

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRIES = [
  "graph-report-sections.ts",
  "graph-report-drift.ts",
  "graph-report-types.ts",
  "dashboard-coupling.ts",
  "dashboard-health.ts",
  "dashboard-node-metrics.ts",
  "graph-arch-compute.ts",
  "graph-arch-types.ts",
  "package-buckets.ts",
];
// dashboard-symbol-coupling.ts is left out: symbol-coupling.ts reaches node:path through
// extractors/ids.ts, so the coupling payload is not yet browser-safe.
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const NODE_GLOBAL_USE = /\b(?:process|Buffer|__dirname|__filename|require|setImmediate)\s*[.([]/;
// Type-only imports are erased at build time, so they cannot pull a module into a bundle.
const ERASED = /\/\*[\s\S]*?\*\/|\/\/.*|(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["']/g;

function importClosure(entries: readonly string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = entries.map((e) => path.join(here, e));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const text = readFileSync(file, "utf8").replace(ERASED, "");
    seen.set(file, text);
    for (const [, spec] of text.matchAll(IMPORT_SPECIFIER)) {
      if (spec!.startsWith(".")) queue.push(path.resolve(path.dirname(file), spec!.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

const closure = [...importClosure(ENTRIES)].map(([file, text]) => ({ file: path.relative(here, file), text }));

describe("report derivations in a browser", () => {
  it("walks past the entry files into their dependencies", () => {
    expect(closure.map((c) => c.file)).toContain("pagerank.ts");
  });

  it.each(closure)("$file imports only relative modules", ({ text }) => {
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);

    expect(specifiers.filter((s) => !s.startsWith("."))).toEqual([]);
  });

  it.each(closure)("$file touches no Node-only global", ({ text }) => {
    expect(text).not.toMatch(NODE_GLOBAL_USE);
  });
});
