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
const PATH_IO_METHODS = /\.(?:write_text|write_bytes|read_text|read_bytes|mkdir|unlink|rmdir|touch|rename|replace|iterdir|glob)$/;
const PARSE_CALLS = new Set([
  "json.loads", "json.load", "yaml.safe_load", "yaml.load", "tomllib.loads", "tomllib.load", "toml.loads",
  "csv.reader", "csv.DictReader", "ast.literal_eval", "struct.unpack", "xml.etree.ElementTree.fromstring",
]);
const PARSE_NAME = /(?:^|_)(?:parse|parser|decode|deserialize|tokenize|lex|loads)(?:_|$)/i;
const OUTPUT_CALLS = /^(?:print|sys\.stdout\.write|sys\.stdout\.buffer\.write|click\.echo|click\.secho|typer\.echo|pprint\.pprint)$/;
const ARGPARSE_CALLS = /(?:^|\.)(?:ArgumentParser|add_argument|parse_args|parse_known_args)$/;
const ENTRY_DECORATOR = /(?:^|\.)(?:command|group|callback|route|get|post|put|patch|delete|websocket)$/;

function isIoCall(callee: string): boolean {
  if (callee === "open" || callee === "io.open" || PATH_IO_METHODS.test(callee)) return true;
  if (PURE_OS_PATH.test(callee)) return false;
  return IO_MODULES.some((m) => callee.startsWith(`${m}.`));
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

/** A module-level `global`/`nonlocal` rebinding, or a mutation of a name assigned at module level. */
function isGlobalWrite(node: Node, moduleNames: ReadonlySet<string>): boolean {
  if (node.type === "global_statement" || node.type === "nonlocal_statement") return true;
  if (node.type !== "assignment" && node.type !== "augmented_assignment") return false;
  const left = node.childForFieldName("left");
  if (left?.type !== "subscript" && left?.type !== "attribute") return false;
  const base = left.childForFieldName(left.type === "subscript" ? "value" : "object");
  return base?.type === "identifier" && moduleNames.has(base.text);
}

const MUTATORS = /^(\w+)\.(?:append|extend|insert|update|add|pop|popitem|clear|setdefault|remove|discard)$/;

/** Classify one function body against the file's imports and module-level names. */
export function codeKindFacts(
  name: string,
  def: Node,
  imports: ReadonlyMap<string, string>,
  moduleNames: ReadonlySet<string>,
): CodeKindFacts {
  const facts = { parser: PARSE_NAME.test(name), io: false, outputSignal: isEntryDecorated(def), globalWrites: false };
  const body = def.childForFieldName("body");
  if (!body) return facts;
  forEachOwnNode(body, (node) => {
    if (isGlobalWrite(node, moduleNames)) facts.globalWrites = true;
    if (node.type !== "call") return;
    const callee = qualifiedCallee(node, imports);
    if (isIoCall(callee)) facts.io = true;
    if (PARSE_CALLS.has(callee)) facts.parser = true;
    if (OUTPUT_CALLS.test(callee) || ARGPARSE_CALLS.test(callee)) facts.outputSignal = true;
    const mutated = MUTATORS.exec(callee)?.[1];
    if (mutated && moduleNames.has(mutated)) facts.globalWrites = true;
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
