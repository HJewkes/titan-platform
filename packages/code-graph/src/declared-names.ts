import type { ParsedFile } from "./parser/index.js";
import type { Node } from "web-tree-sitter";

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

/**
 * Every function/method/class a file DECLARES, mapped to its 1-based line span
 * (the model-B symbol surface, C-64, now carrying spans for C-63 coverage
 * range-containment). A superset of the file's exports: internal helpers like
 * `mergeFragments` are included so they get a `symbol` node (and, by name match,
 * their complexity + coverage) even though nothing imports them. Names come from
 * the same tree-sitter walk that computes complexity, so they never drift.
 * Anonymous declarations (a default-exported arrow, inline callbacks) contribute
 * no name and are skipped. A name declared more than once keeps its last span
 * (overloads / same-named methods are rare; range lookup still resolves most).
 */
export function collectDeclaredSpans(file: ParsedFile): Map<string, LineSpan> {
  const declTypes = file.language === "python" ? PY_DECL_TYPES : TS_DECL_TYPES;
  const spans = new Map<string, LineSpan>();
  const visit = (node: Node): void => {
    const named = declaredNodeAt(node, declTypes);
    if (named) {
      spans.set(named.name, {
        startLine: named.node.startPosition.row + 1,
        endLine: named.node.endPosition.row + 1,
      });
    }
    for (const child of node.children) {
      if (child) visit(child);
    }
  };
  visit(file.tree.rootNode);
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
