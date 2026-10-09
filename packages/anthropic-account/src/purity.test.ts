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

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const ALLOWED_IMPORT = /^(?:\.\/[^/]+\.js|zod)$/;
const IO_GLOBAL = /\b(?:fetch|XMLHttpRequest|WebSocket|process|require|Buffer)\s*[.([]/;

describe("root entry purity", () => {
  it("finds the runtime sources to check", () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(["index.ts", "login.ts", "profile.ts", "redact.ts", "usage.ts"]),
    );
  });

  it.each(sources)("$file imports only zod and sibling files", ({ text }) => {
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1] ?? "");

    expect(specifiers.filter((s) => !ALLOWED_IMPORT.test(s))).toEqual([]);
  });

  it.each(sources)("$file names no fs or network module", ({ text }) => {
    expect(text).not.toMatch(/["'](?:node:)?(?:fs|fs\/promises|net|http|https|http2|tls|dgram|child_process)["']/);
  });

  it.each(sources)("$file calls no network or process global", ({ text }) => {
    expect(text).not.toMatch(IO_GLOBAL);
  });
});
