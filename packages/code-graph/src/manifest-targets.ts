import * as path from "node:path";

/** Single-path fields a runtime, bundler or type checker loads straight from the manifest. */
const PATH_FIELDS = ["main", "module", "types", "typings"] as const;

/** Every string leaf of a value: subpath maps, nested condition objects and fallback arrays alike. */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) stringLeaves(item, out);
}

/** A package-relative posix path, or null for a target outside the package. */
function packageRelative(target: string): string | null {
  const trimmed = target.startsWith("./") ? target.slice(2) : target;
  if (trimmed === "") return target === "./" || target === "." ? "." : null;
  if (path.posix.isAbsolute(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed).replace(/(.)\/$/, "$1");
  return normalized.startsWith("../") || normalized === ".." ? null : normalized;
}

/**
 * Package-relative targets (posix, no `./`, possibly holding one `*`) that a
 * `package.json` declares as entries: `main`, `module`, `types`, `typings`,
 * `bin`, and every condition and subpath of `exports` and `imports`. Node only
 * accepts `./`-prefixed targets in `exports` and `imports`, so a bare specifier
 * there (an `imports` alias onto another package) is not a file of this one.
 * A `null` target (a subpath exclusion) names no file and is skipped.
 */
export function manifestTargets(manifest: Readonly<Record<string, unknown>>): string[] {
  const loose: string[] = [];
  for (const field of PATH_FIELDS) {
    const value = manifest[field];
    if (typeof value === "string") loose.push(value);
  }
  stringLeaves(manifest.bin, loose);
  const mapped: string[] = [];
  stringLeaves(manifest.exports, mapped);
  stringLeaves(manifest.imports, mapped);
  const targets = [...loose, ...mapped.filter((t) => t.startsWith("./"))];
  return [...new Set(targets.map(packageRelative).filter((t): t is string => t !== null))];
}
