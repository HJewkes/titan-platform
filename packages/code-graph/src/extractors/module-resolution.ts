import * as path from "node:path";
import { existsSync } from "node:fs";
import type { FileSystemHost } from "ts-morph";
import { fileId } from "./ids.js";

/** Source/compiled extensions a relative specifier may resolve to, in priority order. */
export const RESOLVABLE_EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/**
 * Candidate on-disk paths for a resolved relative import base, in priority
 * order: an explicit extension already present, then the source extensions,
 * then a NodeNext `.js`→`.ts` remap, then `index.*` for directory imports.
 */
export function* relativeResolutionCandidates(base: string): Iterable<string> {
  yield base;
  for (const ext of RESOLVABLE_EXTS) yield base + ext;
  const jsExt = /\.(?:jsx?|mjs|cjs)$/.exec(base);
  if (jsExt) {
    const stem = base.slice(0, base.length - jsExt[0].length);
    for (const ext of RESOLVABLE_EXTS) yield stem + ext;
  }
  for (const ext of RESOLVABLE_EXTS) yield path.join(base, "index" + ext);
}

/**
 * Resolve a relative specifier from a file to an on-disk absolute path via the
 * ts-morph filesystem host (honours in-memory test fixtures), or null. ts-morph's
 * NodeNext resolution only links relative imports carrying an explicit `.js`
 * extension, so extensionless bundler-style imports (`../types`, common outside
 * the tsconfig project) need this fallback (C-44).
 */
export function resolveRelativeAbs(
  fs: FileSystemHost,
  fromAbs: string,
  specifier: string,
): string | null {
  if (!isRelativeSpecifier(specifier)) return null;
  const base = path.resolve(path.dirname(fromAbs), specifier);
  for (const candidate of relativeResolutionCandidates(base)) {
    if (fs.fileExistsSync(candidate)) return candidate;
  }
  return null;
}

/** Map an abs path to an in-repo file id, or null if out of tree / in node_modules. */
export function inRepoFileId(repoRoot: string, abs: string): string | null {
  const relative = path.relative(repoRoot, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (relative.split(path.sep).includes("node_modules")) return null;
  return fileId(repoRoot, abs);
}

// ts-morph resolves workspace imports like `@codewatch/analyzer` to the
// package's `types` entry (`<pkg>/dist/index.d.ts`), but the indexer's file
// walker excludes `dist/` and `.d.ts`. Without remapping, every cross-package
// edge points to a nonexistent node and the rendered graph fails to construct.
export function remapDistToSrc(abs: string): string {
  const m = /^(.*)[\\/]dist[\\/](.+)\.d\.ts$/.exec(abs);
  if (!m) return abs;
  const base = m[1]!;
  const sub = m[2]!;
  for (const ext of [".ts", ".tsx"]) {
    const candidate = path.join(base, "src", sub + ext);
    if (existsSync(candidate)) return candidate;
  }
  return abs;
}
