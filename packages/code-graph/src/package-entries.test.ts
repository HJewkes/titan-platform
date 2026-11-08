import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReportContext } from "./analysis/graph-report-sections.js";
import { topDeadModules } from "./analysis/dead-modules.js";
import { packageEntryFileIds } from "./package-entries.js";
import type { GraphEdge, GraphNode } from "./types.js";

const REPO = path.join(path.sep, "repo");

/** An in-memory checkout: repo-relative path to file text. */
function memorySource(files: Record<string, string>) {
  const byAbs = new Map(Object.entries(files).map(([rel, text]) => [path.join(REPO, rel), text]));
  return {
    fileExists: (abs: string) => byAbs.has(abs),
    readFile: (abs: string) => {
      const text = byAbs.get(abs);
      if (text === undefined) throw new Error(`ENOENT ${abs}`);
      return text;
    },
  };
}

const json = (value: unknown) => JSON.stringify(value);

const TSCONFIG = json({ compilerOptions: { outDir: "dist", rootDir: "src" } });

const LIB_FILES = [
  "packages/lib/src/index.ts",
  "packages/lib/src/browser.ts",
  "packages/lib/src/alias-target.ts",
  "packages/lib/src/cli.ts",
  "packages/lib/src/orphan.ts",
];

function libSource(manifest: Record<string, unknown>, extra: Record<string, string> = {}) {
  return memorySource({
    "packages/lib/package.json": json({ name: "lib", ...manifest }),
    "packages/lib/tsconfig.json": TSCONFIG,
    ...extra,
  });
}

function deadIds(fileIds: readonly string[], entryIds: ReadonlySet<string>): string[] {
  const nodes: GraphNode[] = fileIds.map((id) => ({ id, kind: "file", name: id, role: "source" }));
  const edges: GraphEdge[] = [];
  const ctx = buildReportContext({ nodes, metrics: [], excluders: [], excludedRoles: new Set(), windowDays: 30 });
  return topDeadModules(nodes, edges, ctx, 50, { entryIds }).map((r) => r.nodeId);
}

describe("package manifest entries as dead-module roots", () => {
  it("a non-barrel subpath export's source file is not dead", () => {
    const source = libSource({ exports: { "./browser": { types: "./dist/browser.d.ts", import: "./dist/browser.js" } } });
    const entries = packageEntryFileIds(REPO, LIB_FILES, source);
    expect(deadIds(LIB_FILES, entries)).not.toContain("packages/lib/src/browser.ts");
  });

  it("an imports #alias target is not dead", () => {
    const source = libSource({ imports: { "#target": { node: "./src/alias-target.js" }, "#dep": "some-package" } });
    const entries = packageEntryFileIds(REPO, LIB_FILES, source);
    expect([...entries]).toEqual(["packages/lib/src/alias-target.ts"]);
    expect(deadIds(LIB_FILES, entries)).not.toContain("packages/lib/src/alias-target.ts");
  });

  it("a dist-mapped main resolves to its src file", () => {
    const source = libSource({ main: "dist/cli.js" });
    expect([...packageEntryFileIds(REPO, LIB_FILES, source)]).toEqual(["packages/lib/src/cli.ts"]);
  });

  it("a truly unreferenced module is still dead", () => {
    const source = libSource({
      main: "./dist/index.js",
      exports: { ".": "./dist/index.js", "./browser": "./dist/browser.js", "./internal/*": null },
      bin: { lib: "./dist/cli.js" },
    });
    const entries = packageEntryFileIds(REPO, LIB_FILES, source);
    expect(deadIds(LIB_FILES, entries)).toEqual(["packages/lib/src/alias-target.ts", "packages/lib/src/orphan.ts"]);
  });

  it("a subpath pattern export covers every source file its star spans", () => {
    const files = ["packages/lib/src/tools/a.ts", "packages/lib/src/tools/deep/b.tsx", "packages/lib/src/other.ts"];
    const source = libSource({ exports: { "./tools/*": "./dist/tools/*.js" } });
    expect([...packageEntryFileIds(REPO, files, source)].sort()).toEqual([
      "packages/lib/src/tools/a.ts",
      "packages/lib/src/tools/deep/b.tsx",
    ]);
  });

  it("an outDir inherited through a relative extends maps against the config that sets it", () => {
    const source = memorySource({
      "packages/app/package.json": json({ name: "app", main: "./build/server.js" }),
      "packages/app/tsconfig.json": json({ extends: "./tsconfig.base", compilerOptions: { rootDir: "./lib" } }),
      "packages/app/tsconfig.base.json": json({ compilerOptions: { outDir: "build" } }),
    });
    const files = ["packages/app/lib/server.ts", "packages/app/src/server.ts"];
    expect([...packageEntryFileIds(REPO, files, source)]).toEqual(["packages/app/lib/server.ts"]);
  });

  it("a tsconfig with comments still yields its output mapping", () => {
    const source = memorySource({
      "package.json": json({ name: "root", types: "./out/api.d.ts" }),
      "tsconfig.build.json": `{\n  // emitted for publishing\n  "compilerOptions": { "outDir": "out", "rootDir": "source", },\n}`,
    });
    expect([...packageEntryFileIds(REPO, ["source/api.ts", "source/other.ts"], source)]).toEqual(["source/api.ts"]);
  });

  it("an unreadable tsconfig keeps the dist-to-src fallback", () => {
    const base = libSource({ main: "./dist/cli.js" });
    const source = {
      fileExists: () => true,
      readFile: (abs: string) => {
        if (abs.endsWith("tsconfig.json") || abs.endsWith("tsconfig.build.json")) throw new Error(`EACCES ${abs}`);
        return base.readFile(abs);
      },
    };
    expect([...packageEntryFileIds(REPO, LIB_FILES, source)]).toEqual(["packages/lib/src/cli.ts"]);
  });

  it("a malformed manifest contributes no entries", () => {
    const source = memorySource({ "packages/lib/package.json": "{ not json" });
    expect(packageEntryFileIds(REPO, LIB_FILES, source).size).toBe(0);
  });
});
