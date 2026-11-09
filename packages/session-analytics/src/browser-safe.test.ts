import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The ./timeline subpath ships to browsers, so its import graph may reach only these two files, and the types file only as types.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string): string => readFileSync(path.join(srcDir, file), "utf8");
const sources = ["timeline-entry.ts", "count-at-or-before.ts"].map((file) => ({ file, text: read(file) }));

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const NODE_GLOBAL_USE = /\b(?:process|Buffer|__dirname|__filename|require|setImmediate)\s*[.([]/;
const ALLOWED = new Set(["./timeline-types.js", "./count-at-or-before.js"]);

describe("browser safety of the ./timeline entry", () => {
  it.each(sources)("$file imports only its own timeline files", ({ text }) => {
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);
    expect(specifiers.filter((s) => !ALLOWED.has(s))).toEqual([]);
  });

  it("re-exports the timeline types with no runtime import", () => {
    const entry = read("timeline-entry.ts");
    expect(entry).not.toMatch(/^import\s+(?!type)/m);
    expect(entry).not.toMatch(/^export\s+(?!type)[^\n]*from\s+"\.\/timeline-types\.js"/m);
  });

  it("keeps timeline-types.ts to type-only imports", () => {
    const imports = read("timeline-types.ts").match(/^import .*$/gm) ?? [];
    expect(imports.filter((line) => !line.startsWith("import type "))).toEqual([]);
  });

  it.each(sources)("$file touches no Node-only global", ({ text }) => {
    expect(text).not.toMatch(NODE_GLOBAL_USE);
  });
});
