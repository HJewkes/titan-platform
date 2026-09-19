import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The main entry ships to browsers, so its runtime source may reach only its own files and rpc-protocol.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(srcDir, "client");
const sources = [
  { file: "index.ts", text: readFileSync(path.join(srcDir, "index.ts"), "utf8") },
  ...readdirSync(clientDir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({ file: `client/${file}`, text: readFileSync(path.join(clientDir, file), "utf8") })),
];

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const NODE_GLOBAL_USE = /\b(?:process|Buffer|__dirname|__filename|require|setImmediate)\s*[.([]/;
const ALLOWED = (specifier: string): boolean =>
  specifier === "@titan-design/rpc-protocol" || specifier.startsWith("./client/") || /^\.\/[\w-]+\.js$/.test(specifier);

describe("browser safety", () => {
  it("finds the runtime sources to check", () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(["index.ts", "client/client.ts", "client/live-source.ts"]));
  });

  it.each(sources)("$file imports only its package's client files and rpc-protocol", ({ text }) => {
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);
    expect(specifiers.filter((s) => !ALLOWED(s))).toEqual([]);
  });

  it.each(sources)("$file touches no Node-only global", ({ text }) => {
    expect(text).not.toMatch(NODE_GLOBAL_USE);
  });
});
