import type { Node } from "web-tree-sitter";

/**
 * Calls a function can make and stay pure without the call graph vouching for them (TP-2170). Anything else must
 * resolve to a `calls` edge whose target is itself pure: an unresolved call (an external library, `input()`,
 * `sys.stderr.write`, `module.func(...)`) means not pure, since a false "pure" is the dangerous direction.
 */
const PURE_BUILTINS = new Set([
  "abs", "all", "any", "bin", "bool", "bytes", "callable", "chr", "dict", "divmod", "enumerate", "filter", "float",
  "format", "frozenset", "getattr", "hasattr", "hash", "hex", "int", "isinstance", "issubclass", "iter", "len", "list",
  "map", "max", "min", "oct", "ord", "pow", "range", "repr", "reversed", "round", "set", "slice", "sorted",
  "str", "sum", "tuple", "type", "zip",
]);
const EXCEPTION_NAME = /^[A-Z]\w*(?:Error|Exception)$/;
const PURE_QUALIFIED = /^(?:math|re|itertools|functools|operator|string|textwrap|unicodedata|statistics|decimal|fractions|heapq|bisect)\.\w+$|^(?:json\.dumps|copy\.copy|copy\.deepcopy|dataclasses\.replace|os\.path\.(?:join|basename|dirname|split|splitext|normpath|normcase|relpath|isabs|commonpath))$/;
/** Methods only str has, under a meaning no I/O or stateful type shares: pure on any receiver. */
const STR_METHODS = new Set([
  "upper", "lower", "casefold", "strip", "lstrip", "rstrip", "split", "rsplit", "splitlines", "startswith",
  "endswith", "format", "title", "capitalize", "zfill", "ljust", "rjust", "center", "partition", "rpartition",
  "removeprefix", "removesuffix", "isdigit", "isalpha", "isalnum", "isspace", "isupper", "islower",
]);
/**
 * Methods str, list or dict share with I/O and stateful types (`Path.replace`, `s3.copy`, `s3.keys`,
 * `Thread.join`): pure only on a receiver proven to be such a value.
 */
const SHARED_VALUE_METHODS = new Set(["replace", "copy", "join", "keys", "values", "items", "get", "count", "index", "find"]);
const VALUE_LITERALS = new Set([
  "string", "concatenated_string", "integer", "float", "true", "false", "none", "list", "dictionary", "set", "tuple",
  "list_comprehension", "dictionary_comprehension", "set_comprehension",
]);
const MUTATORS = new Set([
  "append", "extend", "insert", "update", "add", "pop", "popitem", "clear", "setdefault", "remove", "discard", "sort",
  "reverse",
]);
const RECEIVERS = new Set(["self", "cls"]);

/** The names one function can see, split by who owns the value behind them. */
export interface PurityScope {
  imports: ReadonlyMap<string, string>;
  /** Names the file declares; a call to one resolves through the call graph, never the allow-list. */
  declared: ReadonlySet<string>;
  params: ReadonlySet<string>;
  /** Names the function binds itself, parameters excluded. */
  locals: ReadonlySet<string>;
  /** Module-level names the function has not shadowed. */
  moduleNames: ReadonlySet<string>;
}

/** {@link PurityScope} plus the locals every assignment binds to a str, list, dict, set or tuple value. */
interface ValueScope extends PurityScope {
  values: ReadonlySet<string>;
}

/** The identifier at the root of `a.b[c].d`, or null for a literal or call receiver. */
function rootName(node: Node | null): string | null {
  let current = node;
  while (current?.type === "attribute" || current?.type === "subscript") {
    current = current.childForFieldName(current.type === "attribute" ? "object" : "value");
  }
  return current?.type === "identifier" ? current.text : null;
}

function isBareNameListed(name: string, scope: PurityScope): boolean {
  if (scope.declared.has(name)) return false;
  const imported = scope.imports.get(name);
  if (imported) return PURE_QUALIFIED.test(imported);
  return PURE_BUILTINS.has(name) || EXCEPTION_NAME.test(name);
}

/**
 * True for an expression proven to be a plain str, list, dict, set or tuple value: a literal or comprehension, a
 * pure builtin's result, a str method's result, a shared method on a proven value, or a local bound only to one.
 */
function isValue(node: Node | null, scope: ValueScope): boolean {
  if (!node) return false;
  if (VALUE_LITERALS.has(node.type)) return true;
  if (node.type === "parenthesized_expression") return isValue(node.namedChildren[0] ?? null, scope);
  if (node.type === "identifier") return scope.values.has(node.text);
  if (node.type === "binary_operator") return isValueOperation(node, scope);
  if (node.type !== "call") return false;
  const callee = node.childForFieldName("function");
  if (callee?.type === "identifier") return isBareNameListed(callee.text, scope) && PURE_BUILTINS.has(callee.text);
  if (callee?.type !== "attribute") return false;
  const method = callee.childForFieldName("attribute")?.text ?? "";
  const receiver = callee.childForFieldName("object");
  return STR_METHODS.has(method) || (SHARED_VALUE_METHODS.has(method) && isValue(receiver, scope));
}

/** `+` with a value on either side, or `%` formatting a value, yields one; `/` may build a Path, so it never does. */
function isValueOperation(node: Node, scope: ValueScope): boolean {
  const op = node.childForFieldName("operator")?.type;
  const left = isValue(node.childForFieldName("left"), scope);
  if (op === "%") return left;
  return op === "+" && (left || isValue(node.childForFieldName("right"), scope));
}

function isMethodListed(callee: Node, scope: ValueScope): boolean {
  const receiver = callee.childForFieldName("object");
  const method = callee.childForFieldName("attribute")?.text ?? "";
  const root = rootName(receiver);
  const imported = root !== null && !scope.locals.has(root) ? scope.imports.get(root) : undefined;
  if (imported) return PURE_QUALIFIED.test(imported + callee.text.slice(root!.length));
  if (root !== null && RECEIVERS.has(root)) return false;
  if (MUTATORS.has(method)) return receiver?.type === "identifier" && scope.values.has(receiver.text);
  if (SHARED_VALUE_METHODS.has(method)) return isValue(receiver, scope);
  return STR_METHODS.has(method);
}

/** True when a call is pure by the allow-list alone, so the call graph need not resolve it. */
function isListedPureCall(call: Node, scope: ValueScope): boolean {
  const callee = call.childForFieldName("function");
  if (callee?.type === "identifier") return isBareNameListed(callee.text, scope);
  return callee?.type === "attribute" && isMethodListed(callee, scope);
}

/**
 * True when `node` assigns into, or mutates through a method, state the function does not own: `self`, `cls`, a
 * parameter, a module-level name, or an imported module's state (`os.environ["X"] = v`).
 */
function isStateWrite(node: Node, scope: PurityScope): boolean {
  const imported = (name: string) => scope.imports.has(name) && !scope.locals.has(name);
  const outer = (name: string | null) =>
    name !== null &&
    (RECEIVERS.has(name) || scope.params.has(name) || scope.moduleNames.has(name) || imported(name));
  if (node.type === "global_statement" || node.type === "nonlocal_statement") return true;
  if (node.type === "assignment" || node.type === "augmented_assignment") {
    const left = node.childForFieldName("left");
    return (left?.type === "attribute" || left?.type === "subscript") && outer(rootName(left));
  }
  const callee = node.type === "call" ? node.childForFieldName("function") : null;
  if (callee?.type !== "attribute" || !MUTATORS.has(callee.childForFieldName("attribute")?.text ?? "")) return false;
  return outer(rootName(callee.childForFieldName("object")));
}

interface PurityFacts {
  /** Calls the allow-list does not cover; pure needs the call graph to resolve every one of them. */
  unlistedCalls: number;
  stateWrites: boolean;
}

type ForEachOwn = (root: Node, visit: (n: Node) => void) => void;

/**
 * Locals every plain assignment binds to a value, as a greatest fixpoint: start from every assigned local and drop
 * one whose any right-hand side is not provably a value, until none drops (`acc = []` then `acc = acc + [x]` stays).
 */
function valueLocals(def: Node, scope: PurityScope, forEachOwn: ForEachOwn): Set<string> {
  const bindings = new Map<string, Node[]>();
  forEachOwn(def, (node) => {
    const left = node.type === "assignment" ? node.childForFieldName("left") : null;
    const right = node.childForFieldName("right");
    if (left?.type !== "identifier" || !right || scope.params.has(left.text)) return;
    bindings.set(left.text, [...(bindings.get(left.text) ?? []), right]);
  });
  const values = new Set(bindings.keys());
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, rights] of bindings) {
      if (values.has(name) && !rights.every((r) => isValue(r, { ...scope, values }))) {
        values.delete(name);
        changed = true;
      }
    }
  }
  return values;
}

/** Walk one function's own nodes (parameters and body) for unlisted calls and writes to state it does not own. */
export function purityFacts(def: Node, base: PurityScope, forEachOwn: ForEachOwn): PurityFacts {
  const scope: ValueScope = { ...base, values: valueLocals(def, base, forEachOwn) };
  const facts: PurityFacts = { unlistedCalls: 0, stateWrites: false };
  forEachOwn(def, (node) => {
    if (isStateWrite(node, scope)) facts.stateWrites = true;
    if (node.type === "call" && !isListedPureCall(node, scope)) facts.unlistedCalls++;
  });
  return facts;
}
