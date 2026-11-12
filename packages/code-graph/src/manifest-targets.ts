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

/** A manifest target and the files of it that Node refuses to serve because a more specific `exports` key is `null`. */
export interface ManifestTarget {
  target: string;
  excluding: string[];
}

/**
 * Node serves a subpath from its best-matching key (exact, else longest pattern
 * prefix, then longest key). Where that winner is `null`, the looser `key` must
 * not root the files it names: returns that null key as a pattern on `key`'s target side.
 */
function excludedCapture(key: string, nullKey: string): string | null {
  const [pre = "", suf = ""] = key.split("*");
  const [nullPre = "", nullSuf = ""] = nullKey.split("*");
  const star = nullKey.includes("*");
  const wins = !key.includes("*") ? false : !star || nullPre.length > pre.length || (nullPre === pre && nullKey.length > key.length);
  if (!wins || !nullPre.startsWith(pre) || !nullSuf.endsWith(suf)) return null;
  return nullPre.slice(pre.length) + (star ? "*" : "") + nullSuf.slice(0, nullSuf.length - suf.length);
}

function targetsWithin(value: unknown, excluding: (leaf: string) => string[]): ManifestTarget[] {
  const leaves: string[] = [];
  stringLeaves(value, leaves);
  return leaves.filter((t) => t.startsWith("./")).map((target) => ({ target, excluding: excluding(target) }));
}

function exportsTargets(exports: unknown): ManifestTarget[] {
  const none = () => [];
  const isMap = exports !== null && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).every((k) => k.startsWith("."));
  if (!isMap) return targetsWithin(exports, none);
  const entries = Object.entries(exports);
  const nullKeys = entries.filter(([, value]) => value === null).map(([key]) => key);
  return entries.flatMap(([key, value]) =>
    targetsWithin(value, (leaf) =>
      nullKeys.flatMap((n) => {
        const capture = excludedCapture(key, n);
        return capture === null ? [] : [leaf.replace("*", capture)];
      }),
    ),
  );
}

/**
 * Package-relative targets (posix, no `./`, possibly holding one `*`) that a
 * `package.json` declares as entries: `main`, `module`, `types`, `typings`,
 * `bin`, and every condition and subpath of `exports` and `imports`. Node only
 * accepts `./`-prefixed targets in `exports` and `imports`, so a bare specifier
 * there (an `imports` alias onto another package) is not a file of this one.
 * A `null` target (a subpath exclusion) names no file; in `exports` it instead
 * fills `excluding` on every looser key it overrides.
 */
export function manifestTargets(manifest: Readonly<Record<string, unknown>>): ManifestTarget[] {
  const loose: string[] = [];
  for (const field of PATH_FIELDS) {
    const value = manifest[field];
    if (typeof value === "string") loose.push(value);
  }
  stringLeaves(manifest.bin, loose);
  const all: ManifestTarget[] = [
    ...loose.map((target) => ({ target, excluding: [] })),
    ...exportsTargets(manifest.exports),
    ...targetsWithin(manifest.imports, () => []),
  ];
  const unique = new Map<string, ManifestTarget>();
  for (const entry of all) {
    const target = packageRelative(entry.target);
    if (target === null) continue;
    const excluding = entry.excluding.map(packageRelative).filter((t): t is string => t !== null);
    unique.set([target, ...excluding].join("\0"), { target, excluding });
  }
  return [...unique.values()];
}
