import type { Node } from "web-tree-sitter";

/** Declarations that name the scope they open. */
const TS_NAMED_SCOPES = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "class",
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "internal_module",
]);

/** Values that take the name they are bound to, or open an anonymous scope when unbound. */
const TS_BOUND_SCOPES = new Set([
  "class",
  "arrow_function",
  "function_expression",
  "generator_function",
  "object",
]);

const PY_NAMED_SCOPES = new Set(["function_definition", "class_definition"]);

/** The segment an unbound callback, object or class adds, so its members never merge with a named declaration. */
export const ANONYMOUS_SCOPE = "<anonymous>";

/** Join an enclosing scope path and a declared name into the dotted name a symbol id carries. */
export function qualify(scope: string, name: string): string {
  return scope ? `${scope}.${name}` : name;
}

/**
 * The name a value is bound to: `const x = …`, a class field `x = …`, an object
 * key `x: …`, or `default` for `export default`. Null for a value passed as an
 * argument or returned, which has no stable name.
 */
function bindingName(node: Node): string | null {
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === "variable_declarator" || parent.type === "public_field_definition") {
    return parent.childForFieldName("name")?.text ?? null;
  }
  if (parent.type === "pair") return parent.childForFieldName("key")?.text ?? null;
  if (parent.type === "export_statement") return "default";
  return null;
}

/** The segment this node adds to its descendants' scope path, or null when it opens no named scope. */
function scopeSegment(node: Node, python: boolean): string | null {
  if (python) {
    return PY_NAMED_SCOPES.has(node.type) ? (node.childForFieldName("name")?.text ?? null) : null;
  }
  const own = TS_NAMED_SCOPES.has(node.type) ? node.childForFieldName("name")?.text : undefined;
  if (own) return own;
  if (!TS_BOUND_SCOPES.has(node.type)) return null;
  return bindingName(node) ?? ANONYMOUS_SCOPE;
}

/** Consecutive anonymous scopes collapse to one segment: nesting depth is not identity. */
function enter(scope: string, segment: string | null): string {
  if (!segment) return scope;
  if (segment === ANONYMOUS_SCOPE && (scope === ANONYMOUS_SCOPE || scope.endsWith(`.${ANONYMOUS_SCOPE}`))) {
    return scope;
  }
  return qualify(scope, segment);
}

/**
 * Depth-first walk handing every node the dotted path of the scopes that
 * enclose it (`Job` for a method of `class Job`, `outer` for a function nested
 * in `outer`). A callback argument or an unbound object or class adds
 * `<anonymous>` rather than a position, so the path stays stable when
 * declarations are reordered.
 */
export function walkScopes(
  root: Node,
  python: boolean,
  visit: (node: Node, scope: string) => void,
): void {
  const step = (node: Node, scope: string): void => {
    visit(node, scope);
    const inner = enter(scope, scopeSegment(node, python));
    for (const child of node.children) {
      if (child) step(child, inner);
    }
  };
  step(root, "");
}
