import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const NODE_BUILTINS = new Set(builtinModules);
/** esbuild's target can strip the "node:" prefix, so a bare builtin name (e.g. "crypto") must be banned too. */
function isBanned(specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return NODE_BUILTINS.has(bare) || specifier === "better-sqlite3" || specifier === "@titan-design/store-sqlite";
}

/** Static `from "x"`, bare `import "x"`, dynamic `import("x")`, and `require("x")`. */
const IMPORT_PATTERN =
  /\bfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

export function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** Bundled output only, so a banned import here means the root entry pulled it in, not a test file. */
function collectImportsForFile(file: string, visited: Set<string>, specifiers: Set<string>): void {
  if (visited.has(file)) return;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  for (const specifier of extractSpecifiers(source)) {
    if (specifier.startsWith(".")) {
      collectImportsForFile(path.join(path.dirname(file), specifier), visited, specifiers);
    } else {
      specifiers.add(specifier);
    }
  }
}

describe("extractSpecifiers", () => {
  it("finds a specifier in each of the four import/require forms", () => {
    expect(extractSpecifiers('import { x } from "static-from";')).toEqual(["static-from"]);
    expect(extractSpecifiers('import "bare-import";')).toEqual(["bare-import"]);
    expect(extractSpecifiers('const x = await import("dynamic-import");')).toEqual(["dynamic-import"]);
    expect(extractSpecifiers('const x = require("cjs-require");')).toEqual(["cjs-require"]);
  });
});

describe("root entry import graph", () => {
  it("never imports better-sqlite3, store-sqlite, or a node: builtin", () => {
    const entry = path.join(distDir, "index.js");
    expect(existsSync(entry), `run "pnpm --filter @titan-design/hitl build" before this test (${entry} missing)`).toBe(
      true,
    );

    const specifiers = new Set<string>();
    collectImportsForFile(entry, new Set(), specifiers);

    const violations = [...specifiers].filter(isBanned);
    expect(violations).toEqual([]);
  });
});
