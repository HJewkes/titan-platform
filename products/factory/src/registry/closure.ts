import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { isFactEntry } from "./entry.js";
import { schemaHash, type createRegistry } from "./registry.js";

export interface LockRow {
  closure: string;
  schemaHash: string;
  bump: number;
}
export type ClosureLock = Readonly<Record<string, LockRow>>;
export interface Attestation {
  step: string;
  closure: string;
  pr: number;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  resolveJsonModule: true,
  allowJs: true,
};
const WORKSPACE_DIST = /^((?:packages|products|apps)\/[^/]+)\/dist\/(.+?)(?:\.d)?\.[cm]?[jt]s$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const repoPath = (root: string, file: string): string => relative(root, file).split(sep).join("/");

/** A workspace package resolves to its built `dist`; the closure hashes the `src` file that build came from. */
function sourceOf(root: string, resolved: string): string | undefined {
  const real = realpathSync(resolved);
  const path = repoPath(root, real);
  if (path.startsWith("..") || path.includes("node_modules/")) return undefined;
  const dist = WORKSPACE_DIST.exec(path);
  if (!dist) return real;
  const stems = [dist[2]!, `${dist[2]}/index`];
  const source = stems.flatMap((stem) => SOURCE_EXTENSIONS.map((ext) => join(root, dist[1]!, "src", `${stem}${ext}`))).find(existsSync);
  if (!source) throw new Error(`closure: ${path} has no source under ${dist[1]}/src`);
  return source;
}

function importsOf(root: string, file: string): string[] {
  const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
  return importedFiles.flatMap(({ fileName }) => {
    const resolved = ts.resolveModuleName(fileName, file, COMPILER_OPTIONS, ts.sys).resolvedModule;
    const source = resolved ? sourceOf(root, resolved.resolvedFileName) : undefined;
    return source ? [source] : [];
  });
}

/** The repo files `bodyPath` reaches by import, itself included: relative imports and workspace sources, never node_modules. */
export function closureOf(repoRoot: string, bodyPath: string): { files: string[]; hash: string } {
  const root = realpathSync(repoRoot);
  const seen = new Set<string>();
  const queue = [join(root, bodyPath)];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...importsOf(root, file));
  }
  const lines = [...seen].map((file) => `${repoPath(root, file)}\0${sha256(readFileSync(file))}`).sort();
  return { files: lines.map((line) => line.split("\0")[0]!), hash: sha256(lines.join("\n")) };
}

/** The lock the registry implies now: one row per fact entry. */
export function computeLock(root: string, registry: ReturnType<typeof createRegistry>): ClosureLock {
  const rows = registry.entries.filter(isFactEntry).map((entry) => [entry.name, { closure: closureOf(root, entry.body).hash, schemaHash: schemaHash(entry), bump: entry.version.bump }] as const);
  return Object.fromEntries([...rows].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Steps whose closure moved from `base` with neither a new schema hash, a new bump, nor an attestation for the new closure. */
export function closureVerdict(base: ClosureLock, head: ClosureLock, attestations: readonly Attestation[]): string[] {
  return Object.entries(head).flatMap(([step, row]) => {
    const before = base[step];
    if (!before || before.closure === row.closure) return [];
    if (before.schemaHash !== row.schemaHash || before.bump !== row.bump) return [];
    if (attestations.some((a) => a.step === step && a.closure === row.closure)) return [];
    return [`${step}: its import closure changed; bump its version or attest closure ${row.closure}`];
  });
}

interface CheckInput {
  base: ClosureLock | undefined;
  committed: ClosureLock;
  computed: ClosureLock;
  attestations: readonly Attestation[];
}

/** The whole check: the committed lock must equal the computed one, then pass the verdict against the base. */
export function checkClosures(input: CheckInput): { failures: string[]; notices: string[] } {
  const stale = JSON.stringify(input.committed) === JSON.stringify(input.computed) ? [] : ["closure.lock.json is stale; run `pnpm registry:closure --write`"];
  if (!input.base) return { failures: stale, notices: ["no base closure lock; every step passes this once"] };
  return { failures: [...stale, ...closureVerdict(input.base, input.committed, input.attestations)], notices: [] };
}
