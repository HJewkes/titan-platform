import * as path from "node:path";
import { ts } from "ts-morph";
import { workingTreeSource, type IndexSource } from "./index-source.js";
import { manifestTargets } from "./manifest-targets.js";

type ManifestSource = Pick<IndexSource, "fileExists" | "readFile">;

/** Repo-relative posix dirs: where a build emits (`outDir`) and what it emits from (`rootDir`). */
interface OutputMapping {
  outDir: string;
  rootDir: string;
}

interface CompilerDirs {
  outDir?: string;
  rootDir?: string;
}

/** The configs a package build reads, the dedicated build config first. */
const BUILD_TSCONFIGS = ["tsconfig.build.json", "tsconfig.json"] as const;

/** The convention `remapDistToSrc` already applies to cross-package imports, for a package whose tsconfig names no dirs. */
const DIST_TO_SRC: OutputMapping = { outDir: "dist", rootDir: "src" };

const EXTENSIONLESS_SOURCES = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"] as const;

const MAX_EXTENDS_DEPTH = 8;

/** The source extensions TypeScript resolves an emitted extension back to; longest suffix first. */
const SOURCE_EXTENSIONS: readonly (readonly [string, readonly string[]])[] = [
  [".d.mts", [".mts"]],
  [".d.cts", [".cts"]],
  [".d.ts", [".ts", ".tsx"]],
  [".mjs", [".mts", ".mjs"]],
  [".cjs", [".cts", ".cjs"]],
  [".jsx", [".tsx", ".jsx"]],
  [".js", [".ts", ".tsx", ".js", ".jsx"]],
];

/**
 * Indexed file ids a workspace `package.json` declares as entries (`exports`,
 * `imports`, `main`, `module`, `types`, `bin`), so dead-module reachability can
 * seed from them. Every package dir that holds an indexed file is read; an
 * emitted path maps back to source through the package tsconfig's
 * `outDir`/`rootDir` (following relative `extends`).
 */
export function packageEntryFileIds(
  repoRoot: string,
  fileIds: Iterable<string>,
  source: ManifestSource = workingTreeSource(),
): Set<string> {
  const ids = new Set(fileIds);
  const out = new Set<string>();
  for (const dir of packageDirs(repoRoot, ids, source)) {
    for (const id of entriesOf(repoRoot, dir, ids, source)) out.add(id);
  }
  return out;
}

/** Every ancestor dir of an indexed file (`.` is the repo root) that holds a `package.json`. */
function packageDirs(repoRoot: string, ids: ReadonlySet<string>, source: ManifestSource): string[] {
  const hasManifest = new Map<string, boolean>();
  for (const id of ids) {
    for (let dir = path.posix.dirname(id); !hasManifest.has(dir); dir = path.posix.dirname(dir)) {
      hasManifest.set(dir, source.fileExists(path.join(repoRoot, dir, "package.json")));
    }
  }
  return [...hasManifest].filter(([, has]) => has).map(([dir]) => dir);
}

function entriesOf(repoRoot: string, dir: string, ids: ReadonlySet<string>, source: ManifestSource): string[] {
  const manifest = readJsonObject(source, path.join(repoRoot, dir, "package.json"));
  if (!manifest) return [];
  const mappings = outputMappings(repoRoot, dir, source);
  return manifestTargets(manifest).flatMap((target) => matchTarget(joinId(dir, target), mappings, ids));
}

function readJsonObject(source: ManifestSource, abs: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source.readFile(abs));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function joinId(dir: string, rel: string): string {
  return dir === "." ? rel : `${dir}/${rel}`;
}

function toId(repoRoot: string, abs: string): string | null {
  const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
  if (rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
  return rel === "" ? "." : rel;
}

function outputMappings(repoRoot: string, dir: string, source: ManifestSource): OutputMapping[] {
  const mappings: OutputMapping[] = [];
  for (const name of BUILD_TSCONFIGS) {
    const { outDir, rootDir } = compilerDirs(path.join(repoRoot, dir, name), source, 0);
    const out = outDir === undefined ? null : toId(repoRoot, outDir);
    const root = rootDir === undefined ? null : toId(repoRoot, rootDir);
    if (out !== null && root !== null) mappings.push({ outDir: out, rootDir: root });
  }
  if (mappings.length > 0) return mappings;
  return [{ outDir: joinId(dir, DIST_TO_SRC.outDir), rootDir: joinId(dir, DIST_TO_SRC.rootDir) }];
}

/** `outDir`/`rootDir` as absolute paths, each resolved against the config that sets it. */
function compilerDirs(abs: string, source: ManifestSource, depth: number): CompilerDirs {
  const config = depth > MAX_EXTENDS_DEPTH ? null : readTsconfig(source, abs);
  if (!config) return {};
  const here = path.dirname(abs);
  const parent = extendedConfig(config.extends, here);
  const base = parent === null ? {} : compilerDirs(parent, source, depth + 1);
  const options = isObject(config.compilerOptions) ? config.compilerOptions : {};
  return {
    outDir: typeof options.outDir === "string" ? path.resolve(here, options.outDir) : base.outDir,
    rootDir: typeof options.rootDir === "string" ? path.resolve(here, options.rootDir) : base.rootDir,
  };
}

/** A relative `extends`; a package-name base is a shared preset, not this package's layout. */
function extendedConfig(extendsValue: unknown, here: string): string | null {
  if (typeof extendsValue !== "string" || !extendsValue.startsWith(".")) return null;
  const resolved = path.resolve(here, extendsValue);
  return resolved.endsWith(".json") ? resolved : `${resolved}.json`;
}

function readTsconfig(source: ManifestSource, abs: string): Record<string, unknown> | null {
  if (!source.fileExists(abs)) return null;
  try {
    const { config, error } = ts.parseConfigFileTextToJson(abs, source.readFile(abs)) as { config?: unknown; error?: unknown };
    return error === undefined && isObject(config) ? config : null;
  } catch {
    return null;
  }
}

/** The indexed files one manifest target names, through every output mapping and the target itself. */
function matchTarget(target: string, mappings: readonly OutputMapping[], ids: ReadonlySet<string>): string[] {
  const spellings = [target, ...mappings.flatMap((m) => remapOutput(target, m))];
  if (target.includes("*")) return spellings.flatMap((s) => matchPattern(s, ids));
  return spellings.flatMap(targetCandidates).filter((id) => ids.has(id));
}

/** A target with no extension names a module (`index`) or a directory (`./dist`); resolve both the way Node does. */
function targetCandidates(spelling: string): string[] {
  if (path.posix.extname(spelling) !== "") return sourceCandidates(spelling);
  const bases = [spelling, `${spelling}/index`];
  return [spelling, ...bases.flatMap((base) => EXTENSIONLESS_SOURCES.map((ext) => base + ext))];
}

function remapOutput(target: string, mapping: OutputMapping): string[] {
  if (mapping.outDir === mapping.rootDir) return [];
  if (target === mapping.outDir) return [mapping.rootDir];
  const rest = mapping.outDir === "." ? target : target.startsWith(`${mapping.outDir}/`) ? target.slice(mapping.outDir.length + 1) : null;
  return rest === null ? [] : [joinId(mapping.rootDir, rest)];
}

function sourceCandidates(emitted: string): string[] {
  const match = SOURCE_EXTENSIONS.find(([ext]) => emitted.endsWith(ext));
  if (!match) return [emitted];
  const stem = emitted.slice(0, -match[0].length);
  return [emitted, ...match[1].map((ext) => stem + ext)];
}

/** Indexed files a subpath pattern (`./*` style; `*` spans any run of characters, `/` included) covers. */
function matchPattern(pattern: string, ids: ReadonlySet<string>): string[] {
  const star = pattern.indexOf("*");
  const prefix = escapeRegExp(pattern.slice(0, star));
  const suffixes = sourceCandidates(pattern.slice(star + 1)).map(escapeRegExp);
  const re = new RegExp(`^${prefix}.+(?:${suffixes.join("|")})$`);
  return [...ids].filter((id) => re.test(id));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
