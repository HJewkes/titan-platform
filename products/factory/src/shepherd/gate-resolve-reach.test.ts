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

/** Writes `files` into a fresh directory and returns the names `filesReaching` keeps when `sink.ts` is the only seed. */
function reachingNames(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "gate-resolve-reach-"));
  roots.push(root);
  const paths = Object.entries(files).map(([name, text]) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  });
  const program = ts.createProgram(paths, { ...COMPILER_OPTIONS, noEmit: true });
  const scanned = paths.map((path) => program.getSourceFile(path)).filter((file): file is ts.SourceFile => file !== undefined);
  const inRoot = (file: ts.SourceFile): boolean => file.fileName.startsWith(root);
  const kept = filesReaching(program, inRoot, (file) => basename(file.fileName) === "sink.ts", scanned);
  return kept.map((file) => file.fileName.slice(root.length + 1)).sort();
}

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
});
