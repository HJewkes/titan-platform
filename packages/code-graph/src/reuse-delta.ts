import { RESOLVABLE_EXTS } from "./extractors/module-resolution.js";
import { parseSymbolId } from "./extractors/ids.js";
import type { ReuseBasis } from "./incremental.js";
import type { GraphEdge } from "./types.js";

/**
 * Partial reuse across a file-membership delta (C-20). PR #28 fell back to a full
 * index whenever any file was added or removed, because a byte-identical file's
 * import edges resolve against the *global* file set and can change when a
 * referenced path appears or disappears. This narrows that: only files whose
 * edges are actually affected by the delta re-extract; every other unchanged
 * file is still reused.
 *
 * A stored edge carries its original `specifier`, so an unchanged file's relative
 * imports can be re-resolved over the new file-id set — no filesystem, no
 * ts-morph — to detect two effects: a target that was removed, and a target now
 * shadowed by an added file at a higher-priority resolution path.
 *
 * Known limitation (documented, sound-for-valid-code): a previously *unresolved*
 * relative import (which left no edge — a broken import in a file that didn't
 * compile) that an added file now satisfies is not detected, because there is no
 * stored specifier to re-resolve. Such a file is reused until it next changes.
 *
 * Content changes are handled by `computeContentAffected` below.
 */

/** Posix dirname of a repo-relative file id (`a/b/c.ts` → `a/b`). */
function dirOf(id: string): string {
  const i = id.lastIndexOf("/");
  return i < 0 ? "" : id.slice(0, i);
}

/** Normalize a posix path, collapsing `.` and `..` segments. */
function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

const JS_EXT_RE = /\.(?:jsx?|mjs|cjs)$/;

/** Candidate file ids a relative import base could resolve to, in priority order
 *  — mirrors the extractor's `relativeResolutionCandidates` in id space. */
function* candidateIds(base: string): Iterable<string> {
  yield base;
  for (const ext of RESOLVABLE_EXTS) yield base + ext;
  const jsExt = JS_EXT_RE.exec(base);
  if (jsExt) {
    const stem = base.slice(0, base.length - jsExt[0].length);
    for (const ext of RESOLVABLE_EXTS) yield stem + ext;
  }
  for (const ext of RESOLVABLE_EXTS) yield `${base}/index${ext}`;
}

function isRelative(specifier: string): boolean {
  return specifier === "." || specifier === ".." ||
    specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Resolve a relative specifier from a source file id to a target file id in the
 * current file set, or null when nothing matches — the id-space equivalent of the
 * extractor's filesystem walk, so it yields the same target for the same inputs.
 */
export function resolveRelativeId(
  srcFileId: string,
  specifier: string,
  fileIds: ReadonlySet<string>,
): string | null {
  const base = normalizePosix(`${dirOf(srcFileId)}/${specifier}`);
  for (const candidate of candidateIds(base)) {
    if (fileIds.has(candidate)) return candidate;
  }
  return null;
}

/** The file id an edge's target belongs to (a symbol target `f#x` → `f`). */
function targetFileId(edge: GraphEdge): string {
  return parseSymbolId(edge.dstId)?.fileId ?? edge.dstId;
}

/**
 * File ids that must re-extract because the membership delta changed how their
 * imports resolve: an edge target was removed, or a relative specifier now
 * resolves to a different file (e.g. an added file shadowing the old target).
 * Empty when membership is unchanged — the caller then reuses exactly as before.
 */
export function computeDeltaAffected(
  basis: ReuseBasis,
  currentFileIds: ReadonlySet<string>,
): Set<string> {
  const affected = new Set<string>();
  const removed = new Set<string>();
  for (const id of basis.fingerprints.keys()) {
    if (!currentFileIds.has(id)) removed.add(id);
  }
  const added = currentFileIds.size !== basis.fingerprints.size || removed.size > 0;
  if (!added) return affected; // membership unchanged → nothing forced

  for (const [srcId, edges] of basis.edgesBySrc) {
    if (!currentFileIds.has(srcId)) continue; // src itself gone
    for (const edge of edges) {
      if (isEdgeAffected(edge, srcId, removed, currentFileIds)) {
        affected.add(srcId);
        break;
      }
    }
  }
  return affected;
}

/**
 * File ids whose content hash differs between the basis and the current files:
 * modified, added, or removed.
 */
export function changedFileIds(
  basis: ReuseBasis,
  currentHashes: ReadonlyMap<string, string>,
): Set<string> {
  const changed = new Set<string>();
  for (const [id, hash] of currentHashes) {
    if (basis.fingerprints.get(id) !== hash) changed.add(id);
  }
  for (const id of basis.fingerprints.keys()) {
    if (!currentHashes.has(id)) changed.add(id);
  }
  return changed;
}

/**
 * Unchanged files whose edges a content change elsewhere can alter (TP-3636). An
 * importer's `references` edges resolve, at extract time, through the target's
 * export surface to the declaring file, and a reference that resolved to no
 * symbol node is pruned and leaves no trace. So a byte-identical file whose edge
 * lands on a changed file, or on a file that re-exports (transitively) from one,
 * must re-extract; reusing it carried edges a full index no longer produces, and
 * dropped ones it now does, which made a seeded index differ from a cold one.
 */
export function computeContentAffected(
  basis: ReuseBasis,
  changed: ReadonlySet<string>,
): Set<string> {
  const surface = reExportClosure(basis, changed);
  const affected = new Set<string>();
  for (const [srcId, edges] of basis.edgesBySrc) {
    if (changed.has(srcId)) continue;
    if (edges.some((edge) => surface.has(targetFileId(edge)))) affected.add(srcId);
  }
  return affected;
}

/** `changed` plus every file whose basis `re-exports` edges reach a changed file. */
function reExportClosure(basis: ReuseBasis, changed: ReadonlySet<string>): Set<string> {
  const reExporters = new Map<string, string[]>();
  for (const [srcId, edges] of basis.edgesBySrc) {
    for (const edge of edges) {
      if (edge.kind !== "re-exports") continue;
      const dst = targetFileId(edge);
      reExporters.set(dst, [...(reExporters.get(dst) ?? []), srcId]);
    }
  }
  const seen = new Set(changed);
  const stack = [...changed];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const src of reExporters.get(id) ?? []) {
      if (seen.has(src)) continue;
      seen.add(src);
      stack.push(src);
    }
  }
  return seen;
}

function isEdgeAffected(
  edge: GraphEdge,
  srcId: string,
  removed: ReadonlySet<string>,
  currentFileIds: ReadonlySet<string>,
): boolean {
  if (removed.has(targetFileId(edge))) return true;
  const specifier = (edge.attrs as { specifier?: string } | undefined)?.specifier;
  if (!specifier || !isRelative(specifier)) return false;
  // Re-resolve the relative import; if it now lands on a different file (added
  // shadow, or the old target vanished), the file's edges must be recomputed.
  return resolveRelativeId(srcId, specifier, currentFileIds) !== targetFileId(edge);
}
