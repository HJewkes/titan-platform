import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { COMPILER_OPTIONS, GateResolveClosure, SINK_UNITS, sourceProgram, TOPS } from "./gate-resolve-closure.test-helpers.js";

const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", "fixtures", "test-support"]);
const SOURCE = /\.(ts|tsx|mts|cts)$/;
const NOT_SOURCE = /(\.(test|d)\.[a-z]+|\.test-helpers\.ts|test-fixture\.ts)$/;

/** Every non-test source file the closure scans under a directory, as absolute paths. */
function walkSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkSources(path);
    return SOURCE.test(entry.name) && !NOT_SOURCE.test(entry.name) ? [path] : [];
  });
}

const DependencyMap = z.record(z.string(), z.string()).optional();
const ManifestSchema = z.object({ name: z.string(), dependencies: DependencyMap, devDependencies: DependencyMap, peerDependencies: DependencyMap });

interface Unit {
  dir: string;
  deps: string[];
}

function readUnit(root: string, dir: string): [string, Unit] | undefined {
  const manifest = join(root, dir, "package.json");
  if (!existsSync(manifest)) return undefined;
  const pkg = ManifestSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
  const deps = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].flatMap((group) => Object.keys(group ?? {}));
  return [pkg.name, { dir, deps }];
}

/**
 * Each package, product and app directory that can name a sink, every one after the workspace units it depends on. A
 * unit whose dependency closure misses every sink unit cannot import a sink's type, so the checker would find nothing.
 */
function unitsInOrder(root: string): string[] {
  const units = new Map(TOPS.flatMap((top) => readdirSync(join(root, top)).map((name) => readUnit(root, `${top}/${name}`))).filter((unit) => unit !== undefined));
  const ordered: string[] = [];
  const reach = new Map<string, boolean>();
  const visit = (name: string): boolean => {
    const unit = units.get(name);
    if (!unit) return false;
    const known = reach.get(name);
    if (known !== undefined) return known;
    reach.set(name, false);
    const reaches = unit.deps.map(visit).some(Boolean) || SINK_UNITS.has(unit.dir);
    reach.set(name, reaches);
    if (reaches) ordered.push(unit.dir);
    return reaches;
  };
  [...units.keys()].forEach(visit);
  return ordered;
}

/** Parses each `.d.ts` once for every unit's program: the lib and dependency declarations they all load are the bulk of the work. */
function declarationCachingHost(): ts.CompilerHost {
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const { getSourceFile } = host;
  const parsed = new Map<string, ts.SourceFile | undefined>();
  host.getSourceFile = (name, version, ...rest) => {
    if (!name.endsWith(".d.ts")) return getSourceFile(name, version, ...rest);
    if (!parsed.has(name)) parsed.set(name, getSourceFile(name, version, ...rest));
    return parsed.get(name);
  };
  return host;
}

/** The closure of every non-test source file in the repo, one program per unit so no checker holds the whole tree. */
export function repoClosure(root: string): string[] {
  const closure = new GateResolveClosure(root);
  const host = declarationCachingHost();
  return unitsInOrder(root).flatMap((dir) => {
    const sources = walkSources(join(root, dir));
    return sources.length === 0 ? [] : closure.scan(sourceProgram(sources, host), sources);
  });
}
