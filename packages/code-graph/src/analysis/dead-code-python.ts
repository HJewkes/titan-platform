import type { Node } from "web-tree-sitter";

/**
 * Python counterparts of the TypeScript dead-code counts in dead-code.ts (TP-318).
 * Same three counts, same bias: claim only the decidable case and never flag
 * when unsure. Where Python's semantics differ from TypeScript's, the rule is
 * noted on the function that implements it.
 */

const TERMINALS = new Set([
  "return_statement",
  "raise_statement",
  "break_statement",
  "continue_statement",
]);

/** Nodes that open a new scope: their bindings are not the enclosing function's. */
const SCOPE_TYPES = new Set(["function_definition", "lambda", "class_definition"]);

/** Parameters with a splat can't be dropped from the call shape, so they stop the trailing run. */
const SPLAT_TYPES = new Set(["list_splat_pattern", "dictionary_splat_pattern"]);

const RECEIVERS = new Set(["self", "cls"]);

export interface DeadCodeCounts {
  unreachable: number;
  locals: number;
  params: number;
}

export function pythonDeadCode(root: Node): DeadCodeCounts {
  const out: DeadCodeCounts = { unreachable: 0, locals: 0, params: 0 };
  const visit = (node: Node): void => {
    if (node.type === "block") out.unreachable += unreachableInBlock(node);
    if (node.type === "function_definition") {
      const r = analyzeFunction(node);
      out.locals += r.locals;
      out.params += r.params;
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return out;
}

/** Unlike TypeScript, a `def` after a terminal is not hoisted, so it counts as unreachable too. */
function unreachableInBlock(block: Node): number {
  let seenTerminal = false;
  let count = 0;
  for (const child of block.namedChildren) {
    if (!child) continue;
    if (seenTerminal && child.type !== "comment") count++;
    if (TERMINALS.has(child.type)) seenTerminal = true;
  }
  return count;
}

/**
 * Unused locals and trailing unused parameters of one function. A name counts
 * as used when any identifier in the function's subtree (closures included)
 * reads it. A name also bound in a nested scope is skipped, as TypeScript skips
 * shadowed names; unlike TypeScript, rebinding a name in the function's own
 * scope is one local, because Python assignment does not declare.
 */
function analyzeFunction(fn: Node): { locals: number; params: number } {
  const own = ownBindings(fn);
  const nested = nestedBindings(fn);
  const refs = countReferences(fn, own.declIds);
  const isUnused = (name: string): boolean =>
    !name.startsWith("_") &&
    !nested.has(name) &&
    !own.declared.has(name) &&
    (refs.get(name) ?? 0) === 0;

  let params = 0;
  const paramNames = ownParamNames(fn);
  for (let i = isStub(fn) ? -1 : paramNames.length - 1; i >= 0; i--) {
    const name = paramNames[i] ?? null;
    if (name !== null && isUnused(name)) params++;
    else break;
  }
  const paramSet = new Set(paramNames);
  let locals = 0;
  for (const name of own.locals) {
    if (!paramSet.has(name) && isUnused(name)) locals++;
  }
  return { locals, params };
}

/** A body of only docstrings, `...`, `pass` or `raise NotImplementedError`: an `@overload` or abstract signature, like a bodiless TypeScript overload. */
function isStub(fn: Node): boolean {
  const body = fn.childForFieldName("body");
  return (body?.namedChildren ?? []).every((stmt) => {
    if (!stmt || stmt.type === "comment" || stmt.type === "pass_statement") return true;
    if (stmt.type === "raise_statement") return /^raise NotImplementedError\b/.test(stmt.text);
    const expr = stmt.type === "expression_statement" ? stmt.namedChild(0) : null;
    return expr?.type === "ellipsis" || expr?.type === "string";
  });
}

/**
 * Ordered parameter names; `null` marks a position never flagged that also stops
 * the trailing run (`*args`, `**kwargs`, `self`, `cls`). `*` and `/` separators are not parameters.
 */
function ownParamNames(fn: Node): (string | null)[] {
  const params = fn.childForFieldName("parameters");
  if (!params) return [];
  const out: (string | null)[] = [];
  for (const p of params.namedChildren) {
    if (!p || p.type === "keyword_separator" || p.type === "positional_separator") continue;
    const id = paramIdentifier(p);
    out.push(id && !RECEIVERS.has(id.text) ? id.text : null);
  }
  return out;
}

function paramIdentifier(p: Node): Node | null {
  if (p.type === "identifier") return p;
  if (SPLAT_TYPES.has(p.type)) return null;
  const inner = p.childForFieldName("name") ?? p.namedChild(0);
  return inner?.type === "identifier" ? inner : null;
}

/** The plain identifier an `assignment` binds, or null for unpacking, attribute, subscript or a bare annotation. */
function assignedIdentifier(node: Node): Node | null {
  if (node.type !== "assignment" || !node.childForFieldName("right")) return null;
  const left = node.childForFieldName("left");
  return left?.type === "identifier" ? left : null;
}

interface OwnBindings {
  /** Plain-identifier assignment targets in the function's own scope; unpacking is always-used, as TS destructuring. */
  locals: Set<string>;
  /** Names declared `global` or `nonlocal`: they are not this function's locals. */
  declared: Set<string>;
  declIds: Set<number>;
}

function ownBindings(fn: Node): OwnBindings {
  const out: OwnBindings = { locals: new Set(), declared: new Set(), declIds: new Set() };
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    const id = p ? paramIdentifier(p) : null;
    if (id) out.declIds.add(id.id);
  }
  const walk = (node: Node): void => {
    if (SCOPE_TYPES.has(node.type)) return;
    const id = assignedIdentifier(node);
    if (id) {
      out.locals.add(id.text);
      out.declIds.add(id.id);
    }
    if (node.type === "global_statement" || node.type === "nonlocal_statement") {
      for (const n of node.namedChildren) if (n) out.declared.add(n.text);
    }
    for (const child of node.namedChildren) if (child) walk(child);
  };
  const body = fn.childForFieldName("body");
  if (body) walk(body);
  return out;
}

/** Names bound by parameters or plain assignment inside any scope nested in the function. */
function nestedBindings(fn: Node): Set<string> {
  const out = new Set<string>();
  const walk = (node: Node, nested: boolean): void => {
    const inner = nested || (node !== fn && SCOPE_TYPES.has(node.type));
    if (inner) {
      const id = assignedIdentifier(node);
      if (id) out.add(id.text);
      if (node.type === "parameters" || node.type === "lambda_parameters") {
        for (const p of node.namedChildren) {
          const pid = p ? paramIdentifier(p) : null;
          if (pid) out.add(pid.text);
        }
      }
    }
    for (const child of node.namedChildren) if (child) walk(child, inner);
  };
  walk(fn, false);
  return out;
}

/** Identifier occurrences by name across the function's subtree, minus the own binding sites. */
function countReferences(fn: Node, declIds: ReadonlySet<number>): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (node: Node): void => {
    if (node.type === "identifier" && !declIds.has(node.id)) {
      out.set(node.text, (out.get(node.text) ?? 0) + 1);
    }
    for (const child of node.namedChildren) if (child) walk(child);
  };
  const body = fn.childForFieldName("body");
  if (body) walk(body);
  return out;
}
