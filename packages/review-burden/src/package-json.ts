import { isRecord } from "@titan-design/rpc-protocol/narrow";
import type { PackageJsonChange } from "./config.js";

type Manifest = Record<string, unknown>;

type SurfaceKey = "exports" | "bin" | "name";

/** A key a consumer resolves by that the head side no longer has. */
interface RemovedSurface {
  key: SurfaceKey;
  /** The removed subpath, bin name or package name. */
  value: string;
}

/** Subpaths, bin names and the package name present on the base side and missing on head; a new manifest removes nothing. */
export function removedSurface(change: PackageJsonChange): RemovedSurface[] {
  const { base, head = {} } = change;
  if (!base) return [];
  const removed: RemovedSurface[] = [];
  const baseName = stringOf(base.name);
  if (baseName !== undefined && stringOf(head.name) !== baseName) removed.push({ key: "name", value: baseName });
  for (const value of missing(exportSubpaths(base.exports), exportSubpaths(head.exports))) removed.push({ key: "exports", value });
  for (const value of missing(binNames(base), binNames(head))) removed.push({ key: "bin", value });
  return removed;
}

/** True when `exports` or `bin` differ between the two sides, ignoring key order. */
export function surfaceChanged(change: PackageJsonChange): boolean {
  return (["exports", "bin"] as const).some((key) => canonical(change.base?.[key]) !== canonical(change.head?.[key]));
}

/** Dependency names on head that the base side's same section lacks. */
export function addedDependencies(change: PackageJsonChange, section: "dependencies" | "devDependencies"): string[] {
  const before = new Set(Object.keys(recordOf(change.base?.[section])));
  return Object.keys(recordOf(change.head?.[section])).filter((name) => !before.has(name));
}

// A string or a conditions object both export only the root subpath.
function exportSubpaths(exports: unknown): string[] {
  if (exports === undefined || exports === null) return [];
  if (typeof exports !== "object" || Array.isArray(exports)) return ["."];
  const keys = Object.keys(exports);
  return keys.some((key) => key.startsWith(".")) ? keys : ["."];
}

// A string bin is installed under the package name without its scope.
function binNames(manifest: Manifest): string[] {
  const bin = manifest.bin;
  if (typeof bin === "string") return [(stringOf(manifest.name) ?? "").replace(/^@[^/]+\//, "")];
  return Object.keys(recordOf(bin));
}

function missing(before: string[], after: string[]): string[] {
  const kept = new Set(after);
  return before.filter((value) => !kept.has(value));
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordOf(value: unknown): Manifest {
  return isRecord(value) ? value : {};
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : inner,
  );
}
