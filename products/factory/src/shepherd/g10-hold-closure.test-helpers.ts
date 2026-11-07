import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { COMPILER_OPTIONS } from "./gate-resolve-closure.test-helpers.js";

/** A factory source tree to walk: the real `products/factory/src` through `ts.sys`, or an in-memory fixture. */
export interface SourceTree {
  dir: string;
  names: readonly string[];
  host: ts.ModuleResolutionHost;
}

const isTestName = (name: string): boolean => name.includes(".test.") || name.includes(".test-helpers.");

const toPosix = (path: string): string => path.split(sep).join("/");

/** The real factory source tree: every non-test file under it, at any depth, as paths relative to it. */
export function factoryTree(dir: string): SourceTree {
  const names = readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !isTestName(entry.name))
    .map((entry) => toPosix(relative(dir, join(entry.parentPath, entry.name))));
  return { dir, names: names.sort(), host: ts.sys };
}

/** A resolved file's path relative to the tree, or undefined when it lies outside it. */
function inTreeName(tree: SourceTree, resolved: string): string | undefined {
  const name = toPosix(relative(tree.dir, resolved));
  return name.startsWith("../") ? undefined : name;
}

/** What one module imports inside the tree, and the specifiers the compiler could not resolve, which fail the walk closed. */
interface ModuleImports {
  inTree: string[];
  unresolved: string[];
}

/**
 * The compiler's own import scanner, so value, type-only, re-export and dynamic imports all count. A relative import
 * that leaves the factory source tree is out of this walk (TP-3901 owns those).
 */
function importsOf(tree: SourceTree, name: string): ModuleImports {
  const file = join(tree.dir, name);
  const text = tree.host.readFile(file);
  if (text === undefined) return { inTree: [], unresolved: [name] };
  const specifiers = ts.preProcessFile(text, true, true).importedFiles.map((ref) => ref.fileName).filter((spec) => spec.startsWith("."));
  const result: ModuleImports = { inTree: [], unresolved: [] };
  for (const spec of specifiers) {
    const resolved = ts.resolveModuleName(spec, file, COMPILER_OPTIONS, tree.host).resolvedModule?.resolvedFileName;
    const imported = resolved === undefined ? undefined : inTreeName(tree, resolved);
    if (resolved === undefined) result.unresolved.push(`${name} -> ${spec}`);
    else if (imported !== undefined) result.inTree.push(imported);
  }
  return result;
}

interface HoldClosure {
  reached: string[];
  unresolved: string[];
}

/** Every module the seeds import, transitively, to a fixpoint; test modules are never followed or reported. */
export function holdClosure(tree: SourceTree, seeds: readonly string[]): HoldClosure {
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

/** An in-memory factory source tree for fixtures, resolving imports among its own files only. */
export function fixtureTree(dir: string, files: Record<string, string>): SourceTree {
  const byPath = new Map(Object.entries(files).map(([name, text]) => [join(dir, name), text]));
  const host: ts.ModuleResolutionHost = { fileExists: (path) => byPath.has(path), readFile: (path) => byPath.get(path) };
  return { dir, names: Object.keys(files), host };
}
