import type { ExportDeclaration, Project, SourceFile } from "ts-morph";
import { symbolId } from "./ids.js";
import { inRepoFileId, resolveRelativeAbs } from "./module-resolution.js";

/** Context the re-export walk needs: the ts-morph project and the repo root. */
export interface ReExportCtx {
  project: Project;
  repoRoot: string;
}

/**
 * Trace an imported name to the id of the `symbol` node for the export that
 * physically DECLARES it, walking re-export hops on disk (C-70). ts-morph's own
 * `getExportedDeclarations` already sees through barrels whose specifiers it can
 * resolve; this covers the case it can't — extensionless / out-of-project
 * relative specifiers (the tRPC pattern) — by resolving `specifier` from
 * `importerAbs` and following `export { x } from './b'` and `export * from './b'`
 * hops by hand. Returns null (→ a dangling edge, pruned after assembly) when the
 * name is neither declared here nor forwarded onward.
 */
export function resolveReExportOrigin(
  ctx: ReExportCtx,
  importerAbs: string,
  specifier: string,
  name: string,
): string | null {
  const fs = ctx.project.getFileSystem();
  const targetAbs = resolveRelativeAbs(fs, importerAbs, specifier);
  return targetAbs ? walkReExports(ctx, targetAbs, name, new Set()) : null;
}

function walkReExports(
  ctx: ReExportCtx,
  fileAbs: string,
  name: string,
  visited: Set<string>,
): string | null {
  if (visited.has(fileAbs)) return null;
  visited.add(fileAbs);
  // The indexer adds files to the project one at a time as it extracts them, so
  // a barrel/origin file on this walk may not be loaded yet — pull it from the
  // filesystem host on demand (cached thereafter).
  const sf =
    ctx.project.getSourceFile(fileAbs) ??
    ctx.project.addSourceFileAtPathIfExists(fileAbs);
  if (!sf) return null;
  if (declaresExportLocally(sf, name)) {
    const id = inRepoFileId(ctx.repoRoot, fileAbs);
    return id ? symbolId(id, name) : null;
  }
  const fs = ctx.project.getFileSystem();
  for (const ed of sf.getExportDeclarations()) {
    const spec = ed.getModuleSpecifierValue();
    if (!spec) continue;
    const inward = reExportInwardName(ed, name);
    if (inward === null) continue;
    const targetAbs = resolveRelativeAbs(fs, fileAbs, spec);
    if (!targetAbs) continue;
    const origin = walkReExports(ctx, targetAbs, inward, visited);
    if (origin) return origin;
  }
  return null;
}

/**
 * Whether `sf` physically declares an export named `name` — the same test
 * `buildSymbolNodes` uses to decide a name is this file's own symbol, so a
 * re-export walk that stops here lands on a symbol node that actually exists.
 */
function declaresExportLocally(sf: SourceFile, name: string): boolean {
  const decls = sf.getExportedDeclarations().get(name);
  return !!decls && decls.some((d) => d.getSourceFile() === sf);
}

/**
 * For a re-export `export ... from '...'`, the name to look up in the target
 * module when the outward name is `name`, or null if this declaration does not
 * forward `name`.
 * - `export { a as b } from '...'` forwards outward `b` ← inward `a`.
 * - `export * from '...'` forwards every name unchanged.
 * - `export * as ns from '...'` binds a namespace object, not member names, so
 *   it never forwards an individual `name` (we don't attribute per-member).
 */
function reExportInwardName(ed: ExportDeclaration, name: string): string | null {
  const named = ed.getNamedExports();
  if (named.length > 0) {
    for (const spec of named) {
      const outward = spec.getAliasNode()?.getText() ?? spec.getName();
      if (outward === name) return spec.getName();
    }
    return null;
  }
  if (ed.getNamespaceExport()) return null; // `export * as ns from`
  return name; // bare `export *`
}
