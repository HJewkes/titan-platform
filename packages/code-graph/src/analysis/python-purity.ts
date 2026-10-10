import type { Node } from "web-tree-sitter";

/**
 * Calls a function can make and stay pure without the call graph vouching for them (TP-2170). Anything else must
 * resolve to a `calls` edge whose target is itself pure: an unresolved call (an external library, `input()`,
 * `sys.stderr.write`, `module.func(...)`) means not pure, since a false "pure" is the dangerous direction.
 */
const PURE_BUILTINS = new Set([
  "abs", "all", "any", "bin", "bool", "bytes", "callable", "chr", "dict", "divmod", "enumerate", "filter", "float",
  "format", "frozenset", "getattr", "hasattr", "hash", "hex", "int", "isinstance", "issubclass", "iter", "len", "list",
  "map", "max", "min", "next", "oct", "ord", "pow", "range", "repr", "reversed", "round", "set", "slice", "sorted",
  "str", "sum", "tuple", "type", "zip",
]);
const EXCEPTION_NAME = /^[A-Z]\w*(?:Error|Exception)$/;
const PURE_QUALIFIED = /^(?:math|re|itertools|functools|operator|string|textwrap|unicodedata|statistics|decimal|fractions|heapq|bisect)\.\w+$|^(?:json\.dumps|copy\.copy|copy\.deepcopy|dataclasses\.replace|os\.path\.(?:join|basename|dirname|split|splitext|normpath|normcase|relpath|isabs|commonpath))$/;
/** Methods of str, and the read-only views of dict, that no I/O or stateful type shares under the same meaning. */
const PURE_VALUE_METHODS = new Set([
  "upper", "lower", "casefold", "strip", "lstrip", "rstrip", "split", "rsplit", "splitlines", "join", "replace",
  "startswith", "endswith", "format", "title", "capitalize", "zfill", "ljust", "rjust", "center", "partition",
  "rpartition", "removeprefix", "removesuffix", "isdigit", "isalpha", "isalnum", "isspace", "isupper", "islower",
  "keys", "values", "items", "copy",
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

function isMethodListed(callee: Node, scope: PurityScope): boolean {
  const receiver = callee.childForFieldName("object");
  const method = callee.childForFieldName("attribute")?.text ?? "";
  const root = rootName(receiver);
  const imported = root !== null && !scope.locals.has(root) ? scope.imports.get(root) : undefined;
  if (imported) return PURE_QUALIFIED.test(imported + callee.text.slice(root!.length));
  if (root !== null && RECEIVERS.has(root)) return false;
  if (MUTATORS.has(method)) return receiver?.type === "identifier" && scope.locals.has(receiver.text);
  return PURE_VALUE_METHODS.has(method);
}

/** True when a call is pure by the allow-list alone, so the call graph need not resolve it. */
function isListedPureCall(call: Node, scope: PurityScope): boolean {
  const callee = call.childForFieldName("function");
  if (callee?.type === "identifier") return isBareNameListed(callee.text, scope);
  return callee?.type === "attribute" && isMethodListed(callee, scope);
}

/** True when `node` assigns into, or mutates through a method, state the function does not own. */
function isStateWrite(node: Node, scope: PurityScope): boolean {
  const outer = (name: string | null) =>
    name !== null && (RECEIVERS.has(name) || scope.params.has(name) || scope.moduleNames.has(name));
  if (node.type === "global_statement" || node.type === "nonlocal_statement") return true;
  if (node.type === "assignment" || node.type === "augmented_assignment") {
    const left = node.childForFieldName("left");
    return (left?.type === "attribute" || left?.type === "subscript") && outer(rootName(left));
  }
  const callee = node.type === "call" ? node.childForFieldName("function") : null;
  if (callee?.type !== "attribute" || !MUTATORS.has(callee.childForFieldName("attribute")?.text ?? "")) return false;
  return outer(rootName(callee.childForFieldName("object")));
}

export interface PurityFacts {
  /** Calls the allow-list does not cover; pure needs the call graph to resolve every one of them. */
  unlistedCalls: number;
  stateWrites: boolean;
}

/** Walk one function's own nodes (parameters and body) for unlisted calls and writes to state it does not own. */
export function purityFacts(def: Node, scope: PurityScope, forEachOwn: (root: Node, visit: (n: Node) => void) => void): PurityFacts {
  const facts: PurityFacts = { unlistedCalls: 0, stateWrites: false };
  forEachOwn(def, (node) => {
    if (isStateWrite(node, scope)) facts.stateWrites = true;
    if (node.type === "call" && !isListedPureCall(node, scope)) facts.unlistedCalls++;
  });
  return facts;
}
