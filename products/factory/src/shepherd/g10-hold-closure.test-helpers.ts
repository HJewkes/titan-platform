import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import { COMPILER_OPTIONS } from "./gate-resolve-closure.test-helpers.js";

/** A Shepherd directory to walk: the real one through `ts.sys`, or an in-memory fixture. */
export interface ShepherdTree {
  dir: string;
  names: readonly string[];
  host: ts.ModuleResolutionHost;
}

const isTestName = (name: string): boolean => name.includes(".test.") || name.includes(".test-helpers.");

/** The real Shepherd directory: every non-test file in it, as names relative to it. */
export function shepherdTree(dir: string): ShepherdTree {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !isTestName(entry.name))
    .map((entry) => entry.name);
  return { dir, names, host: ts.sys };
}

/** What one module imports inside the tree, and the specifiers the compiler could not resolve, which fail the walk closed. */
interface ModuleImports {
  inTree: string[];
  unresolved: string[];
}

/**
 * The compiler's own import scanner, so value, type-only, re-export and dynamic imports all count. A relative import
 * that leaves the Shepherd directory is out of this walk (TP-3901 owns those).
 */
function importsOf(tree: ShepherdTree, name: string): ModuleImports {
  const file = join(tree.dir, name);
  const text = tree.host.readFile(file);
  if (text === undefined) return { inTree: [], unresolved: [name] };
  const specifiers = ts.preProcessFile(text, true, true).importedFiles.map((ref) => ref.fileName).filter((spec) => spec.startsWith("."));
  const result: ModuleImports = { inTree: [], unresolved: [] };
  for (const spec of specifiers) {
    const resolved = ts.resolveModuleName(spec, file, COMPILER_OPTIONS, tree.host).resolvedModule?.resolvedFileName;
    if (resolved === undefined) result.unresolved.push(`${name} -> ${spec}`);
    else if (dirname(resolved) === tree.dir) result.inTree.push(relative(tree.dir, resolved).split(sep).join("/"));
  }
  return result;
}

interface HoldClosure {
  reached: string[];
  unresolved: string[];
}

/** Every module the seeds import, transitively, to a fixpoint; test modules are never followed or reported. */
export function holdClosure(tree: ShepherdTree, seeds: readonly string[]): HoldClosure {
  const seen = new Set(seeds);
  const queue = [...seeds];
  const unresolved: string[] = [];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const found = importsOf(tree, next);
    unresolved.push(...found.unresolved);
    for (const name of found.inTree.filter((imported) => !isTestName(imported) && !seen.has(imported))) {
      seen.add(name);
      queue.push(name);
    }
  }
  return { reached: [...seen].sort(), unresolved };
}

/** An in-memory Shepherd directory for fixtures, resolving imports among its own files only. */
export function fixtureTree(dir: string, files: Record<string, string>): ShepherdTree {
  const byPath = new Map(Object.entries(files).map(([name, text]) => [join(dir, name), text]));
  const host: ts.ModuleResolutionHost = { fileExists: (path) => byPath.has(path), readFile: (path) => byPath.get(path) };
  return { dir, names: Object.keys(files), host };
}
