import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { COMPILER_OPTIONS } from "./gate-resolve-closure.test-helpers.js";
import { filesReaching } from "./gate-resolve-reach.test-helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Writes `files` into a fresh directory, scans its `.ts` files outside `node_modules`, and returns the names
 * `filesReaching` keeps when `sink.ts` is the only seed.
 */
function reachingNames(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "gate-resolve-reach-"));
  roots.push(root);
  const paths = Object.entries(files).map(([name, text]) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  });
  const scanRoots = paths.filter((path) => path.endsWith(".ts") && !path.includes("node_modules"));
  const program = ts.createProgram(scanRoots, { ...COMPILER_OPTIONS, noEmit: true });
  const scanned = scanRoots.map((path) => program.getSourceFile(path)).filter((file): file is ts.SourceFile => file !== undefined);
  const kept = filesReaching(program, (file) => basename(file.fileName) === "sink.ts", scanned);
  return kept.map((file) => file.fileName.slice(root.length + 1)).sort();
}

const LIB_PACKAGE = { name: "lib", version: "1.0.0", exports: { ".": { types: "./index.d.ts" }, "./factory": { types: "./factory.d.ts" } } };

const SINK = `export function resolve(gate: string, by: string): void { void gate; void by; }\n`;

describe("the files that reach a resolve sink", () => {
  it("keeps direct and transitive importers and drops a file that imports none", () => {
    const kept = reachingNames({
      "sink.ts": SINK,
      "direct.ts": `import { resolve } from "./sink.js";\nexport const pass = (by: string) => resolve("g", by);\n`,
      "transitive.ts": `import { pass } from "./direct.js";\nexport const answer = () => pass("me");\n`,
      "unrelated.ts": `export const answer = 42;\n`,
    });

    expect(kept).toEqual(["direct.ts", "sink.ts", "transitive.ts"]);
  });

  it("follows re-exports, import() types, dynamic imports and reference paths", () => {
    const kept = reachingNames({
      "sink.ts": SINK,
      "barrel.ts": `export * from "./sink.js";\n`,
      "typed.ts": `export type Resolve = typeof import("./sink.js").resolve;\n`,
      "lazy.ts": `export const load = () => import("./sink.js");\n`,
      "referenced.ts": `/// <reference path="./sink.ts" />\nexport const answer = 1;\n`,
      "unrelated.ts": `export const answer = 42;\n`,
    });

    expect(kept).toEqual(["barrel.ts", "lazy.ts", "referenced.ts", "sink.ts", "typed.ts"]);
  });

  it("keeps every scanned file once a global declaration reaches a sink", () => {
    const kept = reachingNames({
      "sink.ts": SINK,
      "globals.ts": `import { resolve } from "./sink.js";\ndeclare global { var answerGate: typeof resolve; }\nexport {};\n`,
      "unrelated.ts": `export const answer = 42;\n`,
    });

    expect(kept).toEqual(["globals.ts", "sink.ts", "unrelated.ts"]);
  });

  it("keeps only reaching files when a global declaration reaches no sink", () => {
    const kept = reachingNames({
      "sink.ts": SINK,
      "globals.ts": `declare global { var answer: number; }\nexport {};\n`,
      "unrelated.ts": `export const answer = 42;\n`,
    });

    expect(kept).toEqual(["sink.ts"]);
  });

  it("follows a chain through a file outside any unit", () => {
    const kept = reachingNames({
      "packages/hitl/src/sink.ts": SINK,
      "scripts/shim.ts": `export { resolve as answer } from "../packages/hitl/src/sink.js";\n`,
      "products/p/src/user-shim.ts": `import { answer } from "../../../scripts/shim.js";\nexport const pass = () => answer("g", "me");\n`,
    });

    expect(kept).toEqual(["packages/hitl/src/sink.ts", "products/p/src/user-shim.ts", "scripts/shim.ts"]);
  });

  it("keeps every scanned file once a module augmentation reaches a sink", () => {
    const kept = reachingNames({
      "sink.ts": SINK,
      "plain.ts": `export interface Tools { name: string; }\n`,
      "aug.ts": `import type { resolve } from "./sink.js";\ndeclare module "./plain.js" { interface Tools { make(): typeof resolve; } }\nexport {};\n`,
      "user-aug.ts": `import type { Tools } from "./plain.js";\nexport const pass = (t: Tools) => t.make()("g", "me");\n`,
      "unrelated.ts": `export const answer = 42;\n`,
    });

    expect(kept).toEqual(["aug.ts", "plain.ts", "sink.ts", "unrelated.ts", "user-aug.ts"]);
  });

  it("keeps an importer of another library entry point when an augmentation of a library module reaches a sink", () => {
    const kept = reachingNames({
      "sink.ts": SINK,
      "node_modules/lib/package.json": JSON.stringify(LIB_PACKAGE),
      "node_modules/lib/context.d.ts": `export interface ContextVariableMap {}\nexport declare function get<K extends keyof ContextVariableMap>(key: K): ContextVariableMap[K];\n`,
      "node_modules/lib/index.d.ts": `export * from "./context.js";\n`,
      "node_modules/lib/factory.d.ts": `export { get } from "./context.js";\n`,
      "aug.ts": `import type { resolve } from "./sink.js";\ndeclare module "lib" { interface ContextVariableMap { gates: typeof resolve; } }\nexport {};\n`,
      "user.ts": `import { get } from "lib/factory";\nexport const pass = () => get("gates")("g", "me");\n`,
    });

    expect(kept).toEqual(["aug.ts", "sink.ts", "user.ts"]);
  });

  it("follows a library declaration that imports a sink", () => {
    const kept = reachingNames({
      "sink.ts": SINK,
      "node_modules/lib/package.json": JSON.stringify(LIB_PACKAGE),
      "node_modules/lib/context.d.ts": `export { resolve as make } from "../../sink.js";\n`,
      "node_modules/lib/index.d.ts": `export * from "./context.js";\n`,
      "node_modules/lib/factory.d.ts": `export * from "./context.js";\n`,
      "user.ts": `import { make } from "lib/factory";\nexport const pass = () => make("g", "me");\n`,
      "unrelated.ts": `export const answer = 42;\n`,
    });

    expect(kept).toEqual(["sink.ts", "user.ts"]);
  });
});
