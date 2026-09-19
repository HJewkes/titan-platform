import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The main entry ships to browsers, so its runtime source may reach only React, the rpc packages, and its own hooks.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const hooksDir = path.join(srcDir, "hooks");
const sources = [
  { file: "index.ts", text: readFileSync(path.join(srcDir, "index.ts"), "utf8") },
  ...readdirSync(hooksDir)
    .filter((file) => file.endsWith(".ts") && !/\.test\.tsx?$/.test(file))
    .map((file) => ({ file: `hooks/${file}`, text: readFileSync(path.join(hooksDir, file), "utf8") })),
];

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const NODE_GLOBAL_USE = /\b(?:process|Buffer|__dirname|__filename|require|setImmediate)\s*[.([]/;
const ALLOWED = new Set(["react", "@titan-design/rpc-client", "@titan-design/rpc-protocol"]);
const allowed = (specifier: string): boolean =>
  ALLOWED.has(specifier) || specifier.startsWith("./hooks/") || /^\.\/[\w-]+\.js$/.test(specifier);

describe("browser safety", () => {
  it("finds the runtime sources to check", () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(["index.ts", "hooks/hooks.ts", "hooks/query-store.ts"]));
  });

  it.each(sources)("$file imports only React, the rpc packages, and its own hooks", ({ text }) => {
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);
    expect(specifiers.filter((s) => !allowed(s))).toEqual([]);
  });

  it.each(sources)("$file touches no Node-only global", ({ text }) => {
    expect(text).not.toMatch(NODE_GLOBAL_USE);
  });
});
