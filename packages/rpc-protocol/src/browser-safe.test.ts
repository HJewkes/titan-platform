import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Browser bundles import this package, so its runtime source may reach nothing but its own files.

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(srcDir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => ({ file, text: readFileSync(path.join(srcDir, file), "utf8") }));

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const NODE_GLOBAL_USE = /\b(?:process|Buffer|__dirname|__filename|require|setImmediate)\s*[.([]/;

describe("browser safety", () => {
  it("finds the runtime sources to check", () => {
    expect(sources.map((s) => s.file)).toContain("index.ts");
  });

  it.each(sources)("$file imports only sibling files", ({ text }) => {
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]);

    expect(specifiers.filter((s) => !s?.startsWith("./"))).toEqual([]);
  });

  it.each(sources)("$file touches no Node-only global", ({ text }) => {
    expect(text).not.toMatch(NODE_GLOBAL_USE);
  });
});
