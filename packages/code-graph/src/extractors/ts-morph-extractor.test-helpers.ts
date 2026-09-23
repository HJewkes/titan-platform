import {
  Project,
  ScriptTarget,
  ModuleKind,
  ModuleResolutionKind,
} from "ts-morph";
import { parseFile, type ParsedFile } from "@titan-design/code-parser";
import { TsMorphGraphExtractor } from "./ts-morph-extractor.js";
import type { GraphFragment } from "../types.js";

export const REPO_ROOT = "/repo";

const FILES: Record<string, string> = {
  "/repo/src/a.ts": `export const A = 1;\n`,
  "/repo/src/b.ts":
    `import { A } from "./a.js";\nexport const B = A + 1;\n`,
  "/repo/src/index.ts":
    `import { A } from "./a.js";\n` +
    `import { B } from "./b.js";\n` +
    `import { readFile } from "node:fs/promises";\n` +
    `import * as ts from "typescript";\n` +
    `export * from "./a.js";\n` +
    `export const x = A + B + (readFile ? 0 : 1) + (ts ? 0 : 1);\n`,
  "/repo/src/only-external.ts":
    `import { join } from "node:path";\n` +
    `import sub from "@scope/pkg/sub";\n` +
    `export const y = join("a", "b") + sub;\n`,
  "/repo/src/c.ts": `export const C = 1;\n`,
  "/repo/src/multi.ts": `export const P = 1;\nexport const Q = 2;\n`,
  // Dynamic import (C-65): lazily loads c.ts by string literal, plus a computed
  // specifier that must NOT resolve to an edge (unresolvable statically).
  "/repo/src/dyn.ts":
    `export async function load(name: string) {\n` +
    `  const mod = await import("./c.js");\n` +
    `  const other = await import(name);\n` +
    `  return mod.C + (other ? 1 : 0);\n` +
    `}\n`,
  // Destructured dynamic import (C-68): the lazy-command-loading pattern. `P`
  // and the aliased `Q: qq` each credit their origin symbol in multi.ts; the
  // namespace `const ns = await import(...)` binds no specific export, so it
  // gets only the module edge (no symbol reference), like a static `import *`.
  "/repo/src/dyn-destructure.ts":
    `export async function reg() {\n` +
    `  const { P } = await import("./multi.js");\n` +
    `  const { Q: qq } = await import("./multi.js");\n` +
    `  const ns = await import("./c.js");\n` +
    `  return P + qq + (ns ? 0 : 1);\n` +
    `}\n`,
  // Model B (C-64): a mix of exported + internal declarations. `pub` is exported;
  // `helper` (function), the internal arrow-const `arrow`, the class `Priv` and
  // its method `run` all get non-exported symbol nodes. The plain const `CONST`
  // gets none (not callable/class).
  "/repo/src/model-b.ts":
    `export function pub(x: number) { return x > 0 ? x : -x; }\n` +
    `function helper(n: number) { let s = 0; for (let i = 0; i < n; i++) { if (i % 2) s += i; } return s; }\n` +
    `const arrow = (a: number) => a + 1;\n` +
    `const CONST = 42;\n` +
    `class Priv { run(v: number) { return v && CONST; } }\n`,
  // Signature + docstring fixtures (C-79): a documented annotated function, an
  // exported arrow const, a class, and a type alias — the surface `graph context`
  // fills its G1/G2 slots from.
  "/repo/src/documented.ts":
    `/** Adds two numbers together. */\n` +
    `export function add(a: number, b: number): number {\n` +
    `  return a + b;\n` +
    `}\n` +
    `export const scale = (v: number): number => v * 2;\n` +
    `export class Box {}\n` +
    `export type Id = string | number;\n`,
  // Reference-count fixtures (C-51): weight = how often the imported binding is
  // actually used, not how many import statements name it.
  "/repo/src/heavy.ts":
    `import { A } from "./a.js";\n` +
    `import { B as Bee } from "./b.js";\n` +
    `import * as ts from "typescript";\n` +
    `const obj = { A: 0 };\n` +
    `export const h =\n` +
    `  A + A + A + obj.A +\n` + // A used 3×; object key + property access excluded
    `  Bee +\n` + // aliased import counted by its local name
    `  ts.version + ts.sys;\n`, // namespace used 2×; member names excluded
  // Same module imported twice (value + type) folds into one summed edge.
  "/repo/src/folded.ts":
    `import { A } from "./a.js";\n` +
    `import type { A as AT } from "./a.js";\n` +
    `export const f = (x: AT): number => A + A;\n`, // weight = A(2) + AT(1) = 3
  "/repo/src/edge-cases.ts":
    `import "./c.js";\n` + // side-effect import binds nothing → floored to 1
    `import { B } from "./b.js";\n` + // imported but unused → floored to 1
    `import { A } from "./a.js";\n` +
    `export const e = A;\n`,
  "/repo/src/reexport.ts":
    `export * from "./a.js";\n` + // namespace re-export → weight 1
    `export { P, Q } from "./multi.js";\n`, // two named re-exports → weight 2
  // Imports A through the index.ts barrel (which `export *`s from a.ts). Symbol
  // references must credit the origin symbol src/a.ts#A, not src/index.ts#A
  // (C-53 sees through re-export hubs, mirroring C-55's file-level treatment).
  "/repo/src/via-barrel.ts":
    `import { A } from "./index.js";\n` +
    `export const vb = A + A;\n`, // A used 2×
  // C-70: extensionless relative imports through a re-export barrel CHAIN (the
  // tRPC pattern: `import { x } from './barrel'` where the barrel only
  // re-exports x from elsewhere, extensionlessly). ts-morph's NodeNext cannot
  // link extensionless specifiers, so resolution drops to the fs fallback — which
  // must ALSO trace through named + wildcard re-export hops to the origin, or the
  // origin symbol is falsely reported unused despite being referenced.
  "/repo/src/deep/origin.ts": `export function deepFn() { return 1; }\n`,
  // wildcard re-export, extensionless
  "/repo/src/deep/wildcard-barrel.ts": `export * from "./origin";\n`,
  // named re-export through the wildcard barrel, extensionless (2nd hop)
  "/repo/src/deep/named-barrel.ts":
    `export { deepFn } from "./wildcard-barrel";\n`,
  // consumer imports the origin symbol via the 2-hop extensionless chain
  "/repo/src/deep/consumer.ts":
    `import { deepFn } from "./named-barrel";\n` +
    `export const used = deepFn() + deepFn();\n`, // deepFn used 2×
  // aliased re-export hop: outward `renamedFn` ← inward `deepFn` (tRPC has these)
  "/repo/src/deep/aliased-barrel.ts":
    `export { deepFn as renamedFn } from "./wildcard-barrel";\n`,
  "/repo/src/deep/consumer-alias.ts":
    `import { renamedFn } from "./aliased-barrel";\n` +
    `export const u2 = renamedFn();\n`,
  // A directory outside the tsconfig project using extensionless,
  // bundler-style relative imports (like `dashboard/`). ts-morph's NodeNext
  // resolution cannot link these; the filesystem fallback must (C-44).
  "/repo/dashboard/src/types.ts": `export type T = number;\n`,
  "/repo/dashboard/src/theme/index.ts": `export const color = "#000";\n`,
  "/repo/dashboard/src/views/OverviewView.tsx":
    `import type { T } from "../types";\n` +
    `import { color } from "../theme";\n` +
    `import { missing } from "../does-not-exist";\n` +
    `import { useState } from "react";\n` +
    `export const V: T = (useState ? 1 : 0) + (missing ?? 0) + color.length;\n`,
};

export interface Fixture {
  project: Project;
  parsed: Record<string, ParsedFile>;
  extract: (filePath: string) => GraphFragment[];
}

/** An in-memory ts-morph project over FILES with a ready extractor. */
export async function buildFixture(): Promise<Fixture> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
    },
  });
  for (const [filePath, content] of Object.entries(FILES)) {
    project.createSourceFile(filePath, content, { overwrite: true });
  }
  // Flush to the in-memory filesystem so the extractor's relative-import
  // fallback (which probes `fileExistsSync`) sees the fixtures, mirroring how
  // the files exist on disk in a real index run.
  project.saveSync();

  const parsed: Record<string, ParsedFile> = {};
  for (const [filePath, content] of Object.entries(FILES)) {
    parsed[filePath] = await parseFile(content, filePath, "typescript");
  }

  const extractor = new TsMorphGraphExtractor({
    repoRoot: REPO_ROOT,
    project,
  });

  return {
    project,
    parsed,
    extract: (filePath: string) => extractor.extract(parsed[filePath]!),
  };
}
