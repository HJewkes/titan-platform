import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The M1a guard (TP-3099 I8): the effective mode is emitted, not consumed. Only serve wiring, health and the ingress
 * kill switch (TP-3802) may read it now; the reconciler (TP-3402) joins this list when it lands. A recipe or service that
 * imports github-sources/ fails here.
 */
const ALLOWED = ["cli.ts", "ingress/answer.ts", "serve-health.ts", "serve.ts"];

const SRC = fileURLToPath(new URL("..", import.meta.url));
const IMPORTS_SOURCES = /from\s+["'](?:\.\.?\/)+github-sources\//;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "github-sources" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("github-sources importers", () => {
  it("are only serve wiring and health", () => {
    const importers = sourceFiles(SRC)
      .filter((path) => IMPORTS_SOURCES.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .sort();

    expect(importers).toEqual(ALLOWED);
  });
});
