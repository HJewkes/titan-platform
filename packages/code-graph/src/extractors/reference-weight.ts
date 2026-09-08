import {
  Node,
  SyntaxKind,
  type ExportDeclaration,
  type Identifier,
  type ImportDeclaration,
  type SourceFile,
} from "ts-morph";
import type { EdgeKind, GraphEdge } from "../types.js";

/**
 * Reference-count edge weighting (C-51). File-level import/re-export edges carry
 * a `weight` on `attrs` measuring how heavily the source file leans on the
 * target — not merely whether it imports from it. A file that calls one imported
 * helper 30× is more coupled than one that names 30 helpers once; a binary edge
 * cannot tell them apart. Everything here is source-local (it reads only the
 * importing file's text), so the weight stays sound under incremental reuse,
 * which reparses a file only when its own content changes.
 */

/**
 * Fold a specifier into the aggregate, summing weights so parallel imports of
 * one module (e.g. a value import plus a type import) collapse to a single
 * edge whose weight is their combined reference count.
 */
export function addWeightedEdge(
  agg: Map<string, GraphEdge>,
  srcId: string,
  dstId: string,
  kind: EdgeKind,
  specifier: string,
  weight: number,
): void {
  const key = JSON.stringify([kind, dstId]);
  const existing = agg.get(key);
  if (existing) {
    (existing.attrs as { weight: number }).weight += weight;
    return;
  }
  agg.set(key, { srcId, dstId, kind, attrs: { specifier, weight } });
}

/**
 * How many times the importing file actually uses the symbols it brings in,
 * floored at 1 so a live-but-unused import (or a `import "./x"` side-effect
 * import, which binds nothing) still reads as a real dependency.
 */
export function importWeight(
  decl: ImportDeclaration,
  usage: Map<string, number>,
): number {
  const names = importBindingNames(decl);
  if (names.length === 0) return 1; // side-effect import: `import "./x"`
  const used = names.reduce((sum, n) => sum + (usage.get(n) ?? 0), 0);
  return Math.max(used, 1);
}

/**
 * One named or default import binding, pairing the name as *exported by the
 * target module* (what a symbol node is keyed on) with the *local* alias in
 * this file (what usage counts key on). Namespace imports (`import * as ns`)
 * are deliberately excluded: they reference the module as a whole, not any one
 * export, so per-symbol attribution isn't well-defined — the file-level
 * `imports` edge still accounts for them (C-53).
 */
export interface ImportBinding {
  importedName: string;
  localName: string;
}

export function namedImportBindings(decl: ImportDeclaration): ImportBinding[] {
  const out: ImportBinding[] = [];
  const def = decl.getDefaultImport();
  if (def) out.push({ importedName: "default", localName: def.getText() });
  for (const spec of decl.getNamedImports()) {
    out.push({
      importedName: spec.getNameNode().getText(),
      localName: (spec.getAliasNode() ?? spec.getNameNode()).getText(),
    });
  }
  return out;
}

/**
 * Per-binding reference weight: how many times this file uses the imported
 * symbol, floored at 1 so a named-but-only-referenced-once import still reads
 * as a real dependency (naming a symbol is itself a use).
 */
export function bindingWeight(
  binding: ImportBinding,
  usage: Map<string, number>,
): number {
  return Math.max(usage.get(binding.localName) ?? 0, 1);
}

function importBindingNames(decl: ImportDeclaration): string[] {
  const names: string[] = [];
  const def = decl.getDefaultImport();
  if (def) names.push(def.getText());
  const ns = decl.getNamespaceImport();
  if (ns) names.push(ns.getText());
  for (const spec of decl.getNamedImports()) {
    names.push((spec.getAliasNode() ?? spec.getNameNode()).getText());
  }
  return names;
}

/**
 * Re-export edges have no local usage to count — the names pass straight
 * through — so weight them by how many names cross the boundary: the count of
 * re-exported specifiers, or 1 for `export * from`.
 */
export function reExportWeight(decl: ExportDeclaration): number {
  if (decl.isNamespaceExport()) return 1;
  return Math.max(decl.getNamedExports().length, 1);
}

/**
 * Count identifier occurrences per name across the file in a single pass,
 * skipping the import/export declarations themselves and property *name*
 * positions (`obj.foo`, `{ foo: … }`) — those name a member, not a reference to
 * an imported binding. Binding names are unique per file (TS forbids
 * redeclaration), so a name's total attributes cleanly to one edge. Local
 * shadowing (a variable reusing an imported name) can over-count; acceptable
 * for a coupling-strength signal.
 */
export function buildLocalUsageCounts(
  sourceFile: SourceFile,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue;
    if (id.getFirstAncestorByKind(SyntaxKind.ExportDeclaration)) continue;
    if (isPropertyNamePosition(id)) continue;
    const text = id.getText();
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

function isPropertyNamePosition(id: Identifier): boolean {
  const parent = id.getParent();
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) {
    return true;
  }
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) {
    return true;
  }
  return false;
}
