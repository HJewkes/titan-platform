import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// The static report app imports ./query in a browser, so it may reach nothing Node-only.

const queryDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "query");
const sources = readdirSync(queryDir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => ({ file, text: readFileSync(path.join(queryDir, file), "utf8") }));

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const ALLOWED_PACKAGES = new Set(["zod", "@titan-design/rpc-protocol"]);
const NODE_GLOBAL_USE = /\b(?:process|Buffer|__dirname|__filename|require|setImmediate)\s*[.([]/;

async function bundleForBrowser() {
  return build({
    entryPoints: [path.join(queryDir, "index.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
}

describe("./query in a browser", () => {
  it("finds the query sources to check", () => {
    expect(sources.map((s) => s.file)).toContain("index.ts");
  });

  it.each(sources)("$file imports only siblings, zod, and rpc-protocol", ({ text }) => {
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);

    expect(specifiers.filter((s) => !s.startsWith("./") && !ALLOWED_PACKAGES.has(s))).toEqual([]);
  });

  it.each(sources)("$file touches no Node-only global", ({ text }) => {
    expect(text).not.toMatch(NODE_GLOBAL_USE);
  });

  it("bundles for platform browser with no errors or warnings", async () => {
    const result = await bundleForBrowser();

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("pulls in no Node builtin, SQLite, parser, or code-graph module", async () => {
    const { metafile } = await bundleForBrowser();
    const inputs = Object.keys(metafile.inputs);

    expect(inputs.filter((i) => /node:|better-sqlite3|store-sqlite|code-graph|ts-morph|tree-sitter|registry/.test(i))).toEqual([]);
    expect(inputs.some((i) => i.includes("rpc-protocol"))).toBe(true);
  });
});
