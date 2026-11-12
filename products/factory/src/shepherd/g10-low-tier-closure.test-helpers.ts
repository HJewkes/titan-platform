import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { COMPILER_OPTIONS } from "./gate-resolve-closure.test-helpers.js";

/** A repository to walk: files by absolute path, and the workspace packages a bare `@titan-design/*` import names. */
export interface RepoTree {
  root: string;
  host: ts.ModuleResolutionHost;
  /** Package name to its directory, relative to the root. */
  packages: ReadonlyMap<string, string>;
}

const toPosix = (path: string): string => path.split(sep).join("/");

const isTestName = (name: string): boolean => name.includes(".test.") || name.includes(".test-helpers.");

const ManifestSchema = z.object({
  name: z.string(),
  exports: z.record(z.string(), z.union([z.string(), z.object({ import: z.string() })])).optional(),
});

/** Every workspace package under `packages/`, by its npm name. */
function workspacePackages(root: string, host: ts.ModuleResolutionHost): Map<string, string> {
  const packages = new Map<string, string>();
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true }).filter((dirent) => dirent.isDirectory())) {
    const text = host.readFile(join(root, "packages", entry.name, "package.json"));
    if (text !== undefined) packages.set(ManifestSchema.parse(JSON.parse(text)).name, `packages/${entry.name}`);
  }
  return packages;
}

/** The real repository through `ts.sys`. */
export const repoTree = (root: string): RepoTree => ({ root, host: ts.sys, packages: workspacePackages(root, ts.sys) });

/** An in-memory repository for fixtures: files keyed by their root-relative path. */
export function fixtureRepo(root: string, files: Record<string, string>, packages: Record<string, string>): RepoTree {
  const byPath = new Map(Object.entries(files).map(([name, text]) => [join(root, name), text]));
  const host: ts.ModuleResolutionHost = { fileExists: (path) => byPath.has(path), readFile: (path) => byPath.get(path) };
  return { root, host, packages: new Map(Object.entries(packages)) };
}

const WORKSPACE_SPECIFIER = /^(@titan-design\/[^/]+)(\/.+)?$/;

/** A workspace import's built `dist/*.js` entry in its export map, as the `src` path it is built from, without extension. */
function workspaceEntry(tree: RepoTree, dir: string, sub: string | undefined): string | undefined {
  const text = tree.host.readFile(join(tree.root, dir, "package.json"));
  if (text === undefined) return undefined;
  const entry = ManifestSchema.parse(JSON.parse(text)).exports?.[sub === undefined ? "." : `.${sub}`];
  const built = typeof entry === "string" ? entry : entry?.import;
  return built === undefined ? undefined : join(tree.root, dir, built.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ""));
}

/** A workspace import's source file, `src/x.ts` or `src/x/index.ts`; null for a `@titan-design` package from npm. */
function workspaceSource(tree: RepoTree, spec: string): string | undefined | null {
  const [, name, sub] = WORKSPACE_SPECIFIER.exec(spec) ?? [];
  const dir = name === undefined ? undefined : tree.packages.get(name);
  if (dir === undefined) return null;
  const stem = workspaceEntry(tree, dir, sub);
  return stem === undefined ? undefined : [`${stem}.ts`, join(stem, "index.ts")].find((file) => tree.host.fileExists(file));
}

/** One import's file: workspace and relative specifiers resolve, anything else (npm, `node:`) is null, a miss undefined. */
function resolveSpecifier(tree: RepoTree, file: string, spec: string): string | undefined | null {
  if (WORKSPACE_SPECIFIER.test(spec)) return workspaceSource(tree, spec);
  if (!spec.startsWith(".")) return null;
  return ts.resolveModuleName(spec, file, COMPILER_OPTIONS, tree.host).resolvedModule?.resolvedFileName;
}

interface Imports {
  files: string[];
  unresolved: string[];
}

function importsOf(tree: RepoTree, name: string): Imports {
  const file = join(tree.root, name);
  const text = tree.host.readFile(file);
  if (text === undefined) return { files: [], unresolved: [name] };
  const result: Imports = { files: [], unresolved: [] };
  for (const spec of ts.preProcessFile(text, true, true).importedFiles.map((ref) => ref.fileName)) {
    const resolved = resolveSpecifier(tree, file, spec);
    if (resolved === undefined) result.unresolved.push(`${name} -> ${spec}`);
    else if (resolved !== null) result.files.push(toPosix(relative(tree.root, resolved)));
  }
  return result;
}

export interface LowTierClosure {
  reached: string[];
  unresolved: string[];
}

/** Every file the seeds import, value or type-only, across workspace packages, to a fixpoint; test modules are never followed. */
export function lowTierClosure(tree: RepoTree, seeds: readonly string[]): LowTierClosure {
  const seen = new Set(seeds);
  const queue = [...seeds];
  const unresolved: string[] = [];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const found = importsOf(tree, next);
    unresolved.push(...found.unresolved);
    for (const name of found.files.filter((imported) => !isTestName(imported) && !seen.has(imported) && !imported.startsWith("../"))) {
      seen.add(name);
      queue.push(name);
    }
  }
  return { reached: [...seen].sort(), unresolved };
}
