import type { Node } from "web-tree-sitter";

/** Own-declared prop counts of one component (C-97 S3). */
export interface PropStats {
  propCount: number;
  boolPropCount: number;
  unreadProps: number;
}

/** Same-file `interface` and `type` declarations by name; the first of a name wins. */
type TypeDecls =ReadonlyMap<string, Node>;

/** A member's name and its annotated type, or null for a method signature. */
type Members = Map<string, Node | null>;

const PARAM_TYPES = new Set(["required_parameter", "optional_parameter"]);
const MEMBER_TYPES = new Set(["property_signature", "method_signature"]);
const BOOLEAN_LEAVES = new Set(["boolean", "true", "false"]);

export function collectTypeDecls(root: Node): TypeDecls {
  const out = new Map<string, Node>();
  const walk = (node: Node): void => {
    if (node.type === "interface_declaration" || node.type === "type_alias_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name && !out.has(name)) out.set(name, node);
    }
    for (const child of node.namedChildren) {
      if (child) walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * Prop counts of the component function `fn`, whose props are its first parameter. The
 * props type resolves syntactically within the file only, so these stay a pure function of
 * one parse: null when the annotation is missing or names a type this file does not
 * declare. `FC<P>` and `Readonly<P>` are never unwrapped, so they stay absent. Inherited
 * types this file does not declare (`HTMLAttributes<…>`) add nothing.
 */
export function propStatsOf(fn: Node, types: TypeDecls): PropStats | null {
  if (fn.type === "method_definition") return null;
  const params = fn.childForFieldName("parameters");
  if (!params) return null;
  const first = params.namedChildren.find((p) => p !== null && PARAM_TYPES.has(p.type));
  if (!first) return { propCount: 0, boolPropCount: 0, unreadProps: 0 };
  const annotation = first.childForFieldName("type")?.namedChild(0);
  const members: Members = new Map();
  if (!annotation || !collectMembers(annotation, types, new Set(), members)) return null;
  const pattern = first.childForFieldName("pattern");
  return {
    propCount: members.size,
    boolPropCount: [...members.values()].filter(isBooleanType).length,
    unreadProps: pattern ? countUnread(pattern, fn, [...members.keys()]) : 0,
  };
}

/** Adds the own-declared members of `type` to `out`; false when this file cannot resolve it. */
function collectMembers(type: Node, types: TypeDecls, seen: Set<string>, out: Members): boolean {
  switch (type.type) {
    case "object_type":
    case "interface_body":
      addMembers(type, out);
      return true;
    case "parenthesized_type": {
      const inner = type.namedChild(0);
      return inner !== null && collectMembers(inner, types, seen, out);
    }
    case "intersection_type":
      return type.namedChildren
        .map((part) => part !== null && collectMembers(part, types, seen, out))
        .some(Boolean);
    case "type_identifier":
    case "generic_type":
      return collectNamed(type, types, seen, out);
    default:
      return false;
  }
}

function collectNamed(type: Node, types: TypeDecls, seen: Set<string>, out: Members): boolean {
  const name = type.type === "generic_type" ? type.childForFieldName("name")?.text : type.text;
  const decl = name === undefined ? undefined : types.get(name);
  if (name === undefined || !decl) return false;
  if (seen.has(name)) return true;
  seen.add(name);
  if (decl.type === "type_alias_declaration") {
    const value = decl.childForFieldName("value");
    return value !== null && collectMembers(value, types, seen, out);
  }
  const body = decl.childForFieldName("body");
  if (body) addMembers(body, out);
  let resolved = out.size > 0;
  for (const clause of decl.namedChildren) {
    if (clause?.type !== "extends_type_clause") continue;
    for (const base of clause.namedChildren) {
      if (base && collectMembers(base, types, seen, out)) resolved = true;
    }
  }
  return resolved || !hasExtends(decl);
}

function hasExtends(decl: Node): boolean {
  return decl.namedChildren.some((c) => c?.type === "extends_type_clause");
}

/** Own members first, so a redeclared inherited member keeps its own annotation. */
function addMembers(body: Node, out: Members): void {
  for (const member of body.namedChildren) {
    if (!member || !MEMBER_TYPES.has(member.type)) continue;
    const name = member.childForFieldName("name");
    if (!name || out.has(keyText(name))) continue;
    const type = member.type === "property_signature" ? member.childForFieldName("type")?.namedChild(0) : null;
    out.set(keyText(name), type ?? null);
  }
}

function keyText(name: Node): string {
  return name.type === "string" ? (name.namedChild(0)?.text ?? "") : name.text;
}

/** `boolean`, or a union of `true`/`false`/`boolean`, optionally with `undefined`. */
function isBooleanType(type: Node | null): boolean {
  while (type?.type === "parenthesized_type") type = type.namedChild(0);
  if (!type) return false;
  if (type.type !== "union_type") return type.text === "boolean";
  const leaves = unionLeaves(type);
  return leaves.every((t) => BOOLEAN_LEAVES.has(t) || t === "undefined") && leaves.some((t) => BOOLEAN_LEAVES.has(t));
}

function unionLeaves(type: Node): string[] {
  if (type.type === "parenthesized_type") {
    const inner = type.namedChild(0);
    return inner ? unionLeaves(inner) : [];
  }
  if (type.type !== "union_type") return [type.text];
  return type.namedChildren.flatMap((part) => (part ? unionLeaves(part) : []));
}

/** Members never read in `fn`; 0 when the props are forwarded whole or through `...rest`. */
function countUnread(pattern: Node, fn: Node, names: readonly string[]): number {
  const reads =
    pattern.type === "identifier" ? propertyReads(pattern, fn)
    : pattern.type === "object_pattern" ? destructuredReads(pattern, fn)
    : null;
  if (!reads) return 0;
  return names.filter((name) => !reads.has(name)).length;
}

/**
 * Prop names read through `props.<name>` or a `const { … } = props` destructure. Null
 * once `props` is used any other way (passed on, spread, indexed), because then every
 * prop may be read elsewhere.
 */
function propertyReads(param: Node, fn: Node): Set<string> | null {
  const reads = new Set<string>();
  let escapes = false;
  const walk = (node: Node): void => {
    if (node.type === "identifier" && node.text === param.text && node.id !== param.id) {
      const keys = keysReadAt(node);
      if (keys) keys.forEach((key) => reads.add(key));
      else escapes = true;
    }
    for (const child of node.namedChildren) {
      if (child) walk(child);
    }
  };
  walk(fn);
  return escapes ? null : reads;
}

function keysReadAt(use: Node): string[] | null {
  const parent = use.parent;
  if (parent?.type === "member_expression" && parent.childForFieldName("object")?.id === use.id) {
    const property = parent.childForFieldName("property");
    return property?.type === "property_identifier" ? [property.text] : null;
  }
  const pattern = parent?.type === "variable_declarator" ? parent.childForFieldName("name") : null;
  if (pattern?.type !== "object_pattern" || parent?.childForFieldName("value")?.id !== use.id) return null;
  const bindings = patternBindings(pattern);
  return bindings ? [...bindings.keys()] : null;
}

/** Destructured prop names whose binding is referenced in `fn`; null when a `...rest` exists. */
function destructuredReads(pattern: Node, fn: Node): Set<string> | null {
  const bindings = patternBindings(pattern);
  if (!bindings) return null;
  const declIds = new Set<number>();
  for (const binding of bindings.values()) if (binding) declIds.add(binding.id);
  const refs = countReferences(fn, declIds);
  const read = [...bindings].filter(([, binding]) => binding === null || (refs.get(binding.text) ?? 0) > 0);
  return new Set(read.map(([key]) => key));
}

/**
 * Each destructured key and its binding identifier, or null for a key bound to a nested
 * pattern, which counts as read. Null overall when the pattern has a `...rest` element.
 */
function patternBindings(pattern: Node): Map<string, Node | null> | null {
  const out = new Map<string, Node | null>();
  for (const element of pattern.namedChildren) {
    if (!element) continue;
    if (element.type === "rest_pattern") return null;
    if (element.type === "shorthand_property_identifier_pattern") out.set(element.text, element);
    else if (element.type === "object_assignment_pattern") {
      const left = element.childForFieldName("left");
      if (left) out.set(left.text, left);
    } else if (element.type === "pair_pattern") {
      const key = element.childForFieldName("key");
      if (key) out.set(keyText(key), pairBinding(element));
    }
  }
  return out;
}

function pairBinding(pair: Node): Node | null {
  let value = pair.childForFieldName("value");
  if (value?.type === "assignment_pattern") value = value.childForFieldName("left");
  return value?.type === "identifier" ? value : null;
}

/** Value references by name (identifier or object shorthand), minus declarations and shadowed names. */
function countReferences(fn: Node, declIds: ReadonlySet<number>): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (node: Node, shadowed: ReadonlySet<string>): void => {
    const isRef = node.type === "identifier" || node.type === "shorthand_property_identifier";
    if (isRef && !declIds.has(node.id) && !shadowed.has(node.text)) {
      out.set(node.text, (out.get(node.text) ?? 0) + 1);
    }
    const inner = node === fn ? shadowed : withScopeBindings(node, shadowed);
    for (const child of node.namedChildren) {
      if (child) walk(child, inner);
    }
  };
  walk(fn, new Set());
  return out;
}

const SCOPE_FUNCTIONS = new Set(["arrow_function", "function_expression", "function_declaration", "method_definition"]);
const BINDING_LEAVES = new Set(["identifier", "type_identifier", "shorthand_property_identifier_pattern"]);
const DECLARATIONS =new Set(["lexical_declaration", "variable_declaration"]);
const NAMED_DECLARATIONS = new Set(["function_declaration", "generator_function_declaration", "class_declaration"]);

/** `shadowed` plus every name a scope-creating `node` binds for its own subtree. */
function withScopeBindings(node: Node, shadowed: ReadonlySet<string>): ReadonlySet<string> {
  const names = scopeBindings(node);
  return names.length === 0 ? shadowed : new Set([...shadowed, ...names]);
}

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
      if (!SCOPE_FUNCTIONS.has(node.type)) break;
      bind(node.childForFieldName("parameters") ?? node.childForFieldName("parameter"));
      if (node.type === "function_expression") bind(node.childForFieldName("name"));
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
  if (NAMED_DECLARATIONS.has(stmt.type)) {
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
  if (PARAM_TYPES.has(node.type)) {
    const pattern = node.childForFieldName("pattern");
    if (pattern) patternNames(pattern, out);
    return;
  }
  const inner =
    node.type === "pair_pattern" ? node.childForFieldName("value")
    : node.type === "assignment_pattern" || node.type === "object_assignment_pattern" ? node.childForFieldName("left")
    : null;
  if (inner) patternNames(inner, out);
  else if (node.type !== "pair_pattern" && node.type !== "assignment_pattern" && node.type !== "object_assignment_pattern") {
    for (const child of node.namedChildren) {
      if (child && child.type !== "type_annotation") patternNames(child, out);
    }
  }
}
