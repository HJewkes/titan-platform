import type { ParsedFile } from "@titan-design/code-parser";
import type { Node } from "web-tree-sitter";
import { qualify, walkScopes } from "./scope-path.js";

const TS_DECL_TYPES = new Set([
  "function_declaration",
  "method_definition",
  "class_declaration",
]);

const PY_DECL_TYPES = new Set(["function_definition", "class_definition"]);

/** 1-based inclusive line span of a declaration, for coverage range-attribution (C-63). */
export interface LineSpan {
  startLine: number;
  endLine: number;
}

/** One declaration: its own name, its scope-qualified name, and its line span. */
export interface Declaration {
  name: string;
  qualifiedName: string;
  span: LineSpan;
}

/**
 * Every function/method/class a file DECLARES, in source order (the model-B
 * symbol surface, C-64). A superset of the file's exports: internal helpers like
 * `mergeFragments` are included so they get a `symbol` node (and their
 * complexity + coverage) even though nothing imports them. Names come from the
 * same tree-sitter walk that computes complexity, so they never drift.
 * `qualifiedName` prefixes the enclosing named scopes (`Job.run`, `outer.inner`)
 * so same-named members of different classes or functions stay apart (TP-182).
 * Anonymous declarations (a default-exported arrow, inline callbacks) are skipped.
 */
export function collectDeclarations(file: ParsedFile): Declaration[] {
  const out: Declaration[] = [];
  forEachDeclaration(file, (name, qualifiedName, node) => {
    out.push({
      name,
      qualifiedName,
      span: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    });
  });
  return out;
}

/** Visit each declaration's name, scope-qualified name and the node its span and parameters come from. */
export function forEachDeclaration(
  file: ParsedFile,
  visit: (name: string, qualifiedName: string, node: Node) => void,
): void {
  const python = file.language === "python";
  const declTypes = python ? PY_DECL_TYPES : TS_DECL_TYPES;
  walkScopes(file.tree.rootNode, python, (node, scope) => {
    const named = declaredNodeAt(node, declTypes);
    if (named) visit(named.name, qualify(scope, named.name), named.node);
  });
}

/**
 * Qualified declared names mapped to their 1-based line span (C-63 coverage
 * range-containment). One scope binds a name once, as TypeScript and Python do,
 * so a getter/setter pair, a Python property's accessors, and `@overload` stubs
 * share one entry; when a qualified name repeats, the last span wins.
 */
export function collectDeclaredSpans(file: ParsedFile): Map<string, LineSpan> {
  const spans = new Map<string, LineSpan>();
  for (const d of collectDeclarations(file)) spans.set(d.qualifiedName, d.span);
  return spans;
}

/** Declared names only — the Set view over {@link collectDeclaredSpans}. */
export function collectDeclaredNames(file: ParsedFile): Set<string> {
  return new Set(collectDeclaredSpans(file).keys());
}

/**
 * The declaration at this node — its name plus the node whose line span
 * represents it — or null. Mirrors source-metrics' `functionAt` handling of an
 * arrow / function-expression bound to a `const`/`let` (the span is the callable
 * body's node, so it contains the coverage `fnMap` loc), extended to classes.
 */
function declaredNodeAt(
  node: Node,
  declTypes: ReadonlySet<string>,
): { name: string; node: Node } | null {
  if (declTypes.has(node.type)) {
    const name = node.childForFieldName("name")?.text;
    return name ? { name, node } : null;
  }
  if (
    (node.type === "arrow_function" || node.type === "function_expression") &&
    node.parent?.type === "variable_declarator"
  ) {
    const name = node.parent.childForFieldName("name")?.text;
    return name ? { name, node } : null;
  }
  return null;
}
