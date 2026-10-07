import type { Node } from "web-tree-sitter";
import { TS_CLASS_TYPES, TS_DECL_TYPES, TS_FUNCTION_TYPES } from "../node-kinds.js";

const REFERENCE_TYPES = new Set(["identifier", "shorthand_property_identifier"]);
const BINDING_LEAVES = new Set(["identifier", "type_identifier", "shorthand_property_identifier_pattern"]);
const PARAM_TYPES = new Set(["required_parameter", "optional_parameter"]);
const WITH_DEFAULT = new Set(["assignment_pattern", "object_assignment_pattern"]);
const DECLARATIONS = new Set(["lexical_declaration", "variable_declaration"]);

/**
 * Calls `visit` for every identifier reference under `root` (including declaration names)
 * with the names shadowed at that point by scopes nested inside `root`. `root`'s own
 * parameters are not treated as shadowing, so a caller can ask about them.
 */
export function walkReferences(root: Node, visit: (ref: Node, shadowed: ReadonlySet<string>) => void): void {
  const walk = (node: Node, shadowed: ReadonlySet<string>): void => {
    if (REFERENCE_TYPES.has(node.type)) visit(node, shadowed);
    const names = node === root ? [] : scopeBindings(node);
    const inner = names.length === 0 ? shadowed : new Set([...shadowed, ...names]);
    for (const child of node.namedChildren) {
      if (child) walk(child, inner);
    }
  };
  walk(root, new Set());
}

/** The names a scope-creating `node` binds for its own subtree; empty for other nodes. */
function scopeBindings(node: Node): string[] {
  const names: string[] = [];
  const bind = (target: Node | null): void => {
    if (target) patternNames(target, names);
  };
  switch (node.type) {
    case "statement_block":
      declaredIn(node.namedChildren, names);
      break;
    case "switch_body":
      declaredIn(node.namedChildren.flatMap((clause) => clause?.namedChildren ?? []), names);
      break;
    case "for_statement":
      declaredIn([node.childForFieldName("initializer")], names);
      break;
    case "for_in_statement":
      if (node.childForFieldName("kind")) bind(node.childForFieldName("left"));
      break;
    case "catch_clause":
      bind(node.childForFieldName("parameter"));
      break;
    default:
      if (!TS_FUNCTION_TYPES.has(node.type) && !TS_CLASS_TYPES.has(node.type)) break;
      bind(node.childForFieldName("parameters") ?? node.childForFieldName("parameter"));
      bind(node.childForFieldName("name"));
  }
  return names;
}

/** Names bound by the declarations and named function/class declarations among `statements`. */
function declaredIn(statements: readonly (Node | null)[], out: string[]): void {
  for (const stmt of statements) {
    if (stmt) declaredNames(stmt, out);
  }
}

function declaredNames(stmt: Node, out: string[]): void {
  if (TS_DECL_TYPES.has(stmt.type)) {
    const name = stmt.childForFieldName("name");
    if (name) patternNames(name, out);
    return;
  }
  if (!DECLARATIONS.has(stmt.type)) return;
  const targets = stmt.namedChildren.map((decl) =>
    decl?.type === "variable_declarator" ? decl.childForFieldName("name") : null,
  );
  for (const target of targets) {
    if (target) patternNames(target, out);
  }
}

/** Identifiers a binding pattern or parameter list introduces; skips keys and default values. */
function patternNames(node: Node, out: string[]): void {
  if (BINDING_LEAVES.has(node.type)) {
    out.push(node.text);
    return;
  }
  const next = patternChildren(node);
  for (const child of next) patternNames(child, out);
}

function patternChildren(node: Node): Node[] {
  const field = (name: string): Node[] => {
    const child = node.childForFieldName(name);
    return child ? [child] : [];
  };
  if (PARAM_TYPES.has(node.type)) return field("pattern");
  if (node.type === "pair_pattern") return field("value");
  if (WITH_DEFAULT.has(node.type)) return field("left");
  return node.namedChildren.filter((c): c is Node => c !== null && c.type !== "type_annotation");
}
