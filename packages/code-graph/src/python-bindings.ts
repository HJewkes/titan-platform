import type { Node } from "web-tree-sitter";

/**
 * Every Python form that binds a name, keyed by node type, mapped to the subtrees whose identifiers it binds
 * (TP-2170). Only a plain `name = expr` binds a name to a known right-hand side; every other form binds one to a
 * value nothing here can see. The table errs wide: a match capture's class name, or a `del`, counts as a binding,
 * since a caller treating a name as unknown is always safe.
 */
const BINDING_TARGETS: Readonly<Record<string, (node: Node) => (Node | null)[]>> = {
  assignment: (n) => {
    const left = n.childForFieldName("left");
    return left?.type === "identifier" ? [] : [left];
  },
  augmented_assignment: (n) => [n.childForFieldName("left")],
  for_statement: (n) => [n.childForFieldName("left")],
  for_in_clause: (n) => [n.childForFieldName("left")],
  as_pattern: (n) => [n.childForFieldName("alias")],
  named_expression: (n) => [n.childForFieldName("name")],
  case_pattern: (n) => [n],
  import_statement: (n) => [n],
  import_from_statement: (n) => [n],
  delete_statement: (n) => [n],
  global_statement: (n) => [n],
  nonlocal_statement: (n) => [n],
  function_definition: (n) => [n.childForFieldName("name")],
  class_definition: (n) => [n.childForFieldName("name")],
  lambda: (n) => [n.childForFieldName("parameters")],
  parameters: (n) => [n],
};

/** `a.b = v`, `a[i] = v` and `del a[i]` write into `a` without rebinding it. */
const NON_BINDING_TARGETS = new Set(["attribute", "subscript"]);

/** Identifiers a target subtree binds, skipping attribute and subscript targets. */
function identifiersIn(node: Node): string[] {
  if (node.type === "identifier") return [node.text];
  if (NON_BINDING_TARGETS.has(node.type)) return [];
  return node.namedChildren.flatMap((child) => identifiersIn(child));
}

/**
 * The names `node` itself binds: `rhs` is the value for a plain `name = expr`, and null for any other binding form
 * (for and comprehension targets, with/except `as`, unpacking, walrus, augmented assignment, match captures,
 * imports, del, global, nonlocal, a nested def or class, parameters). `x: int` with no value binds nothing.
 */
export function forEachBinding(node: Node, visit: (name: string, rhs: Node | null) => void): void {
  if (node.type === "assignment") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (left?.type === "identifier" && right) visit(left.text, right);
  }
  for (const target of BINDING_TARGETS[node.type]?.(node) ?? []) {
    if (target) for (const name of identifiersIn(target)) visit(name, null);
  }
}
