import * as path from "node:path";
import { isPythonStdlib } from "./python-stdlib.js";

const TS_MODULE_EXT_RE = /\.(?:tsx|ts|jsx|js|mts|cts|mjs|cjs)$/;
const PY_MODULE_EXT_RE = /\.py$/;
/**
 * A Python module keeps a language tag in place of its extension, so `a.py` next
 * to `a.ts` gets a module node of its own instead of sharing `a` with the
 * TypeScript file and losing its language to whichever fragment merges last.
 */
const PY_MODULE_TAG = "@py";

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function repoRelative(repoRoot: string, absPath: string): string {
  const rel = path.relative(repoRoot, absPath);
  return toPosix(rel);
}

export function fileId(repoRoot: string, absPath: string): string {
  return repoRelative(repoRoot, absPath);
}

export function moduleId(repoRoot: string, absPath: string): string {
  const rel = repoRelative(repoRoot, absPath);
  if (PY_MODULE_EXT_RE.test(rel)) return rel.replace(PY_MODULE_EXT_RE, PY_MODULE_TAG);
  return rel.replace(TS_MODULE_EXT_RE, "");
}

export function parentModuleId(id: string): string | null {
  const idx = id.lastIndexOf("/");
  if (idx < 0) return null;
  return id.slice(0, idx);
}

export function packageId(name: string): string {
  return name;
}

export { SYMBOL_ID_SEP, parseSymbolId, symbolId } from "./symbol-id.js";

export function externalId(specifier: string): string {
  if (specifier.startsWith("node:")) {
    return specifier;
  }
  return `npm:${bareName(specifier)}`;
}

/**
 * External id for an absolute Python import the tree does not hold: `python:` for
 * the standard library, `pypi:` for anything else, keyed by the top-level package
 * so `requests` and `requests.adapters` share one node. Relative imports never
 * reach here; an unresolved one names no installable package.
 */
export function pythonExternalId(dotted: string): string {
  const top = dotted.split(".")[0] ?? dotted;
  return isPythonStdlib(top) ? `python:${top}` : `pypi:${top}`;
}

function bareName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  const slash = specifier.indexOf("/");
  return slash < 0 ? specifier : specifier.slice(0, slash);
}
