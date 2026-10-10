import type { Node } from "web-tree-sitter";

/** What one Python function does by itself, before the call graph is consulted (TP-2170). */
export interface CodeKindFacts {
  parser: boolean;
  io: boolean;
  /** Prints, writes stdout, builds an argparse parser, or is declared a CLI command or web route. */
  outputSignal: boolean;
  globalWrites: boolean;
}

const NESTED_SCOPES = new Set(["function_definition", "class_definition", "lambda"]);

/** Every node under `root`, without entering a nested def or class, whose behaviour is its own symbol's. */
export function forEachOwnNode(root: Node, visit: (node: Node) => void): void {
  for (const child of root.namedChildren) {
    if (!child) continue;
    visit(child);
    if (!NESTED_SCOPES.has(child.type)) forEachOwnNode(child, visit);
  }
}

/**
 * Local names bound by `import a.b [as c]` and `from a import b [as c]`, mapped to
 * the dotted name they stand for, so `run(...)` after `from subprocess import run`
 * reads as `subprocess.run`.
 */
export function importedNames(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (!stmt) continue;
    const from = stmt.type === "import_from_statement" ? stmt.childForFieldName("module_name")?.text : undefined;
    for (const item of stmt.childrenForFieldName("name")) {
      const name = item?.type === "aliased_import" ? item.childForFieldName("name")?.text : item?.text;
      const alias = item?.type === "aliased_import" ? item.childForFieldName("alias")?.text : undefined;
      if (!name) continue;
      const local = alias ?? (from ? name : name.split(".")[0]!);
      out.set(local, from ? `${from}.${name}` : alias ? name : local);
    }
  }
  return out;
}

/** A call's callee as a dotted name with its first segment expanded through the file's imports. */
export function qualifiedCallee(call: Node, imports: ReadonlyMap<string, string>): string {
  const text = call.childForFieldName("function")?.text ?? "";
  const dot = text.indexOf(".");
  const head = dot < 0 ? text : text.slice(0, dot);
  const expanded = imports.get(head);
  return expanded ? expanded + text.slice(head.length) : text;
}

const IO_MODULES = ["subprocess", "socket", "requests", "httpx", "urllib.request", "shutil", "os"];
const PURE_OS_PATH = /^os\.path\.(?:join|basename|dirname|split|splitext|normpath|normcase|relpath|isabs|commonpath)$/;
/**
 * The one table of file methods, keyed by what the receiver must be for the call to touch the filesystem.
 * `any`: only paths and file objects have the method, so whatever receiver it is called on reads or writes a
 * file, and nothing in the file need prove the receiver is a `Path` (`self.root.read_text()`). `path`: `str` or
 * other common types share the name (`str.replace`, `str.rename` on pandas), so it counts only on a proven `Path`.
 * `read` marks the methods whose result is a file's content, for the golden-file check in python-test-kinds.ts.
 */
const FILE_METHODS: ReadonlyMap<string, { receiver: "any" | "path"; read?: true }> = new Map([
  ["read_text", { receiver: "any", read: true }],
  ["read_bytes", { receiver: "any", read: true }],
  ["write_text", { receiver: "any" }],
  ["write_bytes", { receiver: "any" }],
  ["mkdir", { receiver: "any" }],
  ["rmdir", { receiver: "any" }],
  ["unlink", { receiver: "any" }],
  ["touch", { receiver: "any" }],
  ["iterdir", { receiver: "any" }],
  ["rglob", { receiver: "any" }],
  ["symlink_to", { receiver: "any" }],
  ["open", { receiver: "any" }],
  ["read", { receiver: "path", read: true }],
  ["replace", { receiver: "path" }],
  ["rename", { receiver: "path" }],
  ["glob", { receiver: "path" }],
]);

function methodCall(call: Node): { method: string; receiver: Node | null } | null {
  const callee = call.type === "call" ? call.childForFieldName("function") : null;
  if (callee?.type !== "attribute") return null;
  return { method: callee.childForFieldName("attribute")?.text ?? "", receiver: callee.childForFieldName("object") };
}

/** True when `call` touches the filesystem through a {@link FILE_METHODS} method on a receiver that qualifies. */
function isFileMethodCall(call: Node, isPathReceiver: (receiver: Node | null) => boolean): boolean {
  const m = methodCall(call);
  const entry = m ? FILE_METHODS.get(m.method) : undefined;
  if (!m || !entry) return false;
  return entry.receiver === "any" || isPathReceiver(m.receiver);
}

/** True for an expression whose value is a file's content: `p.read_text()`, `f.read()`, `open(x).read()`. */
export function isFileRead(node: Node): boolean {
  const m = methodCall(node);
  return m !== null && FILE_METHODS.get(m.method)?.read === true;
}

const PATH_CONSTRUCTORS = new Set(["pathlib.Path", "pathlib.PurePath", "Path"]);
const PARSE_CALLS = new Set([
  "json.loads", "json.load", "yaml.safe_load", "yaml.load", "tomllib.loads", "tomllib.load", "toml.loads",
  "csv.reader", "csv.DictReader", "ast.literal_eval", "struct.unpack", "xml.etree.ElementTree.fromstring",
]);
const PARSE_NAME = /(?:^|_)(?:parse|parser|decode|deserialize|tokenize|lex|loads)(?:_|$)/i;
const OUTPUT_CALLS = /^(?:print|sys\.stdout\.write|sys\.stdout\.buffer\.write|click\.echo|click\.secho|typer\.echo|pprint\.pprint)$/;
const ARGPARSE_CALLS = /(?:^|\.)(?:ArgumentParser|add_argument|parse_args|parse_known_args)$/;
const ENTRY_DECORATOR = /(?:^|\.)(?:command|group|callback|route|get|post|put|patch|delete|websocket)$/;

/** What one function binds: names that hold a path, and names it binds locally (parameters included). */
interface FunctionScope {
  imports: ReadonlyMap<string, string>;
  pathNames: Set<string>;
  localNames: Set<string>;
}

/** True for a `Path(...)` call, `path / "x"` on one, or a name bound to one; a `str.replace` receiver is not. */
function isPathValue(node: Node | null, scope: FunctionScope): boolean {
  if (!node) return false;
  if (node.type === "parenthesized_expression") return isPathValue(node.namedChildren[0] ?? null, scope);
  if (node.type === "identifier") return scope.pathNames.has(node.text);
  if (node.type === "binary_operator") return isPathValue(node.childForFieldName("left"), scope);
  return node.type === "call" && PATH_CONSTRUCTORS.has(qualifiedCallee(node, scope.imports));
}

function isIoCall(call: Node, callee: string, scope: FunctionScope): boolean {
  if (callee === "open" || callee === "io.open") return true;
  if (isFileMethodCall(call, (receiver) => isPathValue(receiver, scope))) return true;
  if (PURE_OS_PATH.test(callee)) return false;
  return IO_MODULES.some((m) => callee.startsWith(`${m}.`));
}

/** Parameters, with those annotated `Path` also recorded as paths. */
function bindParameters(def: Node, scope: FunctionScope): void {
  for (const param of def.childForFieldName("parameters")?.namedChildren ?? []) {
    const id = param?.type === "identifier" ? param : param?.descendantsOfType("identifier")[0];
    if (!id) continue;
    scope.localNames.add(id.text);
    if (/\b(?:Path|PurePath)\b/.test(param?.childForFieldName("type")?.text ?? "")) scope.pathNames.add(id.text);
  }
}

/** Plain `name = value` bindings in the body, minus names it declares `global` or `nonlocal`. */
function bindLocals(body: Node, scope: FunctionScope): void {
  const declaredOuter = new Set<string>();
  forEachOwnNode(body, (node) => {
    if (node.type === "global_statement" || node.type === "nonlocal_statement") {
      for (const id of node.namedChildren) if (id?.type === "identifier") declaredOuter.add(id.text);
    }
    const left = node.type === "assignment" ? node.childForFieldName("left") : null;
    if (left?.type !== "identifier") return;
    scope.localNames.add(left.text);
    if (isPathValue(node.childForFieldName("right"), scope)) scope.pathNames.add(left.text);
  });
  for (const name of declaredOuter) scope.localNames.delete(name);
}

/** Decorators that make a def a click or typer command, or a Flask or FastAPI route. */
function isEntryDecorated(def: Node): boolean {
  if (def.parent?.type !== "decorated_definition") return false;
  return def.parent.namedChildren.some((d) => {
    if (d?.type !== "decorator") return false;
    const expr = d.namedChildren[0];
    const target = expr?.type === "call" ? expr.childForFieldName("function") : expr;
    return target !== null && target !== undefined && ENTRY_DECORATOR.test(target.text);
  });
}

/** A module-level `global`/`nonlocal` rebinding, or a mutation of a module-level name the function does not shadow. */
function isGlobalWrite(node: Node, isModuleName: (name: string) => boolean): boolean {
  if (node.type === "global_statement" || node.type === "nonlocal_statement") return true;
  if (node.type !== "assignment" && node.type !== "augmented_assignment") return false;
  const left = node.childForFieldName("left");
  if (left?.type !== "subscript" && left?.type !== "attribute") return false;
  const base = left.childForFieldName(left.type === "subscript" ? "value" : "object");
  return base?.type === "identifier" && isModuleName(base.text);
}

const MUTATORS = /^(\w+)\.(?:append|extend|insert|update|add|pop|popitem|clear|setdefault|remove|discard)$/;

function scopeOf(def: Node, body: Node, imports: ReadonlyMap<string, string>): FunctionScope {
  const scope: FunctionScope = { imports, pathNames: new Set(), localNames: new Set() };
  bindParameters(def, scope);
  bindLocals(body, scope);
  return scope;
}

/** Classify one function body against the file's imports and module-level names; `name` is its qualified name. */
export function codeKindFacts(
  name: string,
  def: Node,
  imports: ReadonlyMap<string, string>,
  moduleNames: ReadonlySet<string>,
): CodeKindFacts {
  const ownName = name.slice(name.lastIndexOf(".") + 1);
  const facts = { parser: PARSE_NAME.test(ownName), io: false, outputSignal: isEntryDecorated(def), globalWrites: false };
  const body = def.childForFieldName("body");
  if (!body) return facts;
  const scope = scopeOf(def, body, imports);
  const isModuleName = (n: string) => moduleNames.has(n) && !scope.localNames.has(n);
  forEachOwnNode(body, (node) => {
    if (isGlobalWrite(node, isModuleName)) facts.globalWrites = true;
    if (node.type !== "call") return;
    const callee = qualifiedCallee(node, imports);
    if (isIoCall(node, callee, scope)) facts.io = true;
    if (PARSE_CALLS.has(callee)) facts.parser = true;
    if (OUTPUT_CALLS.test(callee) || ARGPARSE_CALLS.test(callee)) facts.outputSignal = true;
    const mutated = MUTATORS.exec(callee)?.[1];
    if (mutated && isModuleName(mutated)) facts.globalWrites = true;
  });
  return facts;
}

/** Names bound by a plain assignment at module level: the state a function can write behind its callers' backs. */
export function moduleAssignedNames(root: Node): Set<string> {
  const out = new Set<string>();
  for (const stmt of root.namedChildren) {
    const expr = stmt?.type === "expression_statement" ? stmt.namedChildren[0] : null;
    const left = expr?.type === "assignment" ? expr.childForFieldName("left") : null;
    if (left?.type === "identifier") out.add(left.text);
  }
  return out;
}

const MAIN_GUARD = /^__name__\s*==\s*["']__main__["']$|^["']__main__["']\s*==\s*__name__$/;

/** Bare names called inside a module-level `if __name__ == "__main__":` block. */
export function mainGuardCallees(root: Node): Set<string> {
  const out = new Set<string>();
  for (const stmt of root.namedChildren) {
    if (stmt?.type !== "if_statement" || !MAIN_GUARD.test(stmt.childForFieldName("condition")?.text ?? "")) continue;
    for (const call of stmt.descendantsOfType("call")) {
      const callee = call?.childForFieldName("function");
      if (callee?.type === "identifier") out.add(callee.text);
    }
  }
  return out;
}
