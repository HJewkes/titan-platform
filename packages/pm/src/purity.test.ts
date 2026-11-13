import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The root entry is the pure schema surface every host imports; file work lives only behind the ./node subpath,
// so no root source may import a module outside zod and its siblings, or touch an I/O global.

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(srcDir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => ({ file, text: readFileSync(path.join(srcDir, file), "utf8") }));

// Prose in pm's doc comments quotes paths and `from` phrases, so comments are dropped before scanning.
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:"'`])\/\/.*$/gm;
const IMPORT_SPECIFIER = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
const ALLOWED_IMPORT = /^(?:\.\/[^/]+\.js|zod)$/;
const DYNAMIC_IMPORT = /\bimport\s*\(/;
const IO_MODULE = /["'`](?:node:)?(?:fs|fs\/promises|net|http|https|http2|tls|dgram|child_process)["'`]/;
const IO_GLOBAL = /\b(?:fetch|XMLHttpRequest|WebSocket|process|require|Buffer)\s*[.([]/;

function violations(source: string): string[] {
  const text = source.replace(COMMENT, "");
  const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1] ?? m[2] ?? "");
  const found = specifiers.filter((s) => !ALLOWED_IMPORT.test(s)).map((s) => `import ${s}`);
  const checks: [RegExp, string][] = [
    [DYNAMIC_IMPORT, "dynamic import"],
    [IO_MODULE, "fs or network module"],
    [IO_GLOBAL, "I/O global"],
  ];
  return found.concat(checks.filter(([pattern]) => pattern.test(text)).map(([, name]) => name));
}

describe("the purity detector", () => {
  it.each([
    ['import { readFileSync } from "node:fs";'],
    ['import { atomicWrite } from "@titan-design/locator";'],
    ['import { parse } from "yaml";'],
    ['import { withPlanLock } from "./node/plan-lock.js";'],
    ['export { withPlanLock } from "./node/index.js";'],
    ['import "node:fs";'],
    ['const fs = await import("node:fs");'],
    ["process.env.HOME;"],
  ])("flags %s", (text) => {
    expect(violations(text)).not.toEqual([]);
  });

  it("passes zod and sibling imports", () => {
    expect(violations('import { z } from "zod";\nimport { a } from "./a.js";')).toEqual([]);
  });

  it("ignores import-like prose in comments", () => {
    expect(violations('/** Read from "runs.tsv" in the folder. */\n// from "<root>/categories.yml"\nimport { z } from "zod";')).toEqual([]);
  });
});

describe("root entry purity", () => {
  it("finds the runtime sources to check", () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(["index.ts", "planning.ts", "task.ts"]));
  });

  it.each(sources)("$file imports only zod and siblings and uses no I/O", ({ text }) => {
    expect(violations(text)).toEqual([]);
  });
});
