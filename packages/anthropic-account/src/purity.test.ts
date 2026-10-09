import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The root entry handles credential shapes, so it must not be able to read a file or reach
// the network. I/O belongs to a separate subpath.

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(srcDir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => ({ file, text: readFileSync(path.join(srcDir, file), "utf8") }));

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["'`]([^"'`]+)["'`]/g;
const ALLOWED_IMPORT = /^(?:\.\/[^/]+\.js|zod)$/;
const DYNAMIC_IMPORT = /\bimport\s*\(/;
const IO_MODULE = /["'`](?:node:)?(?:fs|fs\/promises|net|http|https|http2|tls|dgram|child_process)["'`]/;
const IO_GLOBAL = /\b(?:fetch|XMLHttpRequest|WebSocket|process|require|Buffer)\s*[.([]/;
const IO_NAME_AS_KEY = /\[\s*["'`](?:fetch|XMLHttpRequest|WebSocket|process|require|Buffer)["'`]\s*\]/;

function violations(text: string): string[] {
  const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1] ?? "");
  const found = specifiers.filter((s) => !ALLOWED_IMPORT.test(s)).map((s) => `import ${s}`);
  const checks: [RegExp, string][] = [
    [DYNAMIC_IMPORT, "dynamic import"],
    [IO_MODULE, "fs or network module"],
    [IO_GLOBAL, "I/O global"],
    [IO_NAME_AS_KEY, "I/O global by key"],
  ];
  return found.concat(checks.filter(([pattern]) => pattern.test(text)).map(([, name]) => name));
}

describe("the purity detector", () => {
  it.each([
    ['import { readFileSync } from "node:fs";'],
    ["import fs from 'fs';"],
    ['import { request } from "node:https";'],
    ["const fs = await import(`node:fs`);"],
    ['const net = await import("node:net");'],
    ["await fetch(url);"],
    ['await globalThis["fetch"](url);'],
    ["await globalThis[`fetch`](url);"],
    ["process.env.HOME;"],
    ['const x = require("child_process");'],
  ])("flags %s", (text) => {
    expect(violations(text)).not.toEqual([]);
  });

  it("passes zod and sibling imports", () => {
    expect(violations('import { z } from "zod";\nimport { a } from "./a.js";')).toEqual([]);
  });
});

describe("root entry purity", () => {
  it("finds the runtime sources to check", () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(["index.ts", "login.ts", "profile.ts", "redact.ts", "usage.ts"]),
    );
  });

  it.each(sources)("$file imports only zod and siblings and uses no I/O", ({ text }) => {
    expect(violations(text)).toEqual([]);
  });
});
