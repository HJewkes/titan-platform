import type { ParsedFile } from "@titan-design/code-parser";
import type { Node } from "web-tree-sitter";
import { forEachDeclaration } from "../declared-names.js";
import { walkScopes } from "../scope-path.js";
import type { GraphEdge } from "../types.js";
import { addCallSite, type CallSite } from "./call-sites.js";
import { hasReceiver } from "./callable-params.js";
import { symbolId } from "./ids.js";

/** Resolves a dotted module name, relative or absolute, from this file to an in-repo file id. */
export type ResolveModule = (specifier: string) => string | null;

interface PyCallContext {
  fileId: string;
  declarations: Map<string, Node>;
  imports: Map<string, { fileId: string; name: string }>;
}

/**
 * `calls` edges for the Python calls that resolve without a type checker
 * (TP-323): a bare name declared at module level in this file, a bare name bound
 * by `from <in-repo module> import <name>`, and `self.<name>(...)` to a method of
 * the enclosing class. Attribute chains, `module.func`, star imports and names a
 * parameter or nested def shadows are dropped. The caller is the enclosing def
 * or class, or the file for a module-level call.
 */
export function collectPythonCallEdges(file: ParsedFile, fileId: string, resolve: ResolveModule): GraphEdge[] {
  const declarations = new Map<string, Node>();
  forEachDeclaration(file, (_name, qualifiedName, node) => declarations.set(qualifiedName, node));
  const ctx: PyCallContext = { fileId, declarations, imports: fromImports(file.tree.rootNode, resolve) };
  const agg = new Map<string, GraphEdge>();
  walkScopes(file.tree.rootNode, true, (node, scope) => {
    if (node.type !== "call") return;
    const dst = resolveCallee(node.childForFieldName("function"), scope, ctx);
    const args = node.childForFieldName("arguments");
    if (!dst || args?.type !== "argument_list") return;
    const srcId = declarations.has(scope) ? symbolId(fileId, scope) : fileId;
    addCallSite(agg, srcId, dst, pythonCallSite(args));
  });
  return [...agg.values()];
}

function resolveCallee(callee: Node | null, scope: string, ctx: PyCallContext): string | null {
  if (callee?.type === "identifier") return resolveBareName(callee.text, scope, ctx);
  if (callee?.type === "attribute") return resolveSelfMethod(callee, scope, ctx);
  return null;
}

function resolveBareName(name: string, scope: string, ctx: PyCallContext): string | null {
  if (isShadowed(name, scope, ctx)) return null;
  const local = ctx.declarations.has(name);
  const imported = ctx.imports.get(name);
  if (local && imported) return null;
  if (local) return symbolId(ctx.fileId, name);
  return imported ? symbolId(imported.fileId, imported.name) : null;
}

/** True when a scope enclosing the call declares `name` as a nested def or class, or binds it as a parameter. */
function isShadowed(name: string, scope: string, ctx: PyCallContext): boolean {
  const segments = scope ? scope.split(".") : [];
  for (let depth = segments.length; depth > 0; depth--) {
    const enclosing = segments.slice(0, depth).join(".");
    if (ctx.declarations.has(`${enclosing}.${name}`)) return true;
    if (parameterNames(ctx.declarations.get(enclosing)).includes(name)) return true;
  }
  return false;
}

/**
 * `self.name(...)` inside a method of class `C`: the def `name` on `C`, or else on
 * the first of `C`'s bases declared in this file that has it, depth first. The
 * receiver is the method's first parameter. A base from another file ends the search.
 */
function resolveSelfMethod(callee: Node, scope: string, ctx: PyCallContext): string | null {
  const receiver = callee.childForFieldName("object");
  const attr = callee.childForFieldName("attribute")?.text;
  const method = ctx.declarations.get(scope);
  if (receiver?.type !== "identifier" || !attr || !method || !hasReceiver(method)) return null;
  if (parameterNames(method)[0] !== receiver.text) return null;
  const owner = findMethodOwner(scope.slice(0, scope.lastIndexOf(".")), attr, ctx, new Set());
  return owner ? symbolId(ctx.fileId, `${owner}.${attr}`) : null;
}

function findMethodOwner(className: string, attr: string, ctx: PyCallContext, seen: Set<string>): string | null {
  const cls = ctx.declarations.get(className);
  if (cls?.type !== "class_definition" || seen.has(className)) return null;
  seen.add(className);
  if (ctx.declarations.get(`${className}.${attr}`)?.type === "function_definition") return className;
  for (const base of cls.childForFieldName("superclasses")?.namedChildren ?? []) {
    if (base?.type !== "identifier" || !ctx.declarations.has(base.text)) return null;
    const owner = findMethodOwner(base.text, attr, ctx, seen);
    if (owner) return owner;
  }
  return null;
}

/** Every parameter name of a def, receiver and `*args` / `**kw` included; empty for a class or nothing. */
function parameterNames(def: Node | undefined): string[] {
  if (def?.type !== "function_definition") return [];
  const out: string[] = [];
  for (const param of def.childForFieldName("parameters")?.namedChildren ?? []) {
    const id = param?.type === "identifier" ? param : param?.descendantsOfType("identifier")[0];
    if (id) out.push(id.text);
  }
  return out;
}

/** Local names bound by `from <module> import <name> [as <alias>]` whose module resolves in-repo. */
function fromImports(root: Node, resolve: ResolveModule): PyCallContext["imports"] {
  const out: PyCallContext["imports"] = new Map();
  for (const stmt of root.descendantsOfType("import_from_statement")) {
    const moduleName = stmt?.childForFieldName("module_name")?.text;
    const moduleFile = moduleName ? resolve(moduleName) : null;
    if (!stmt || !moduleFile) continue;
    for (const imported of stmt.childrenForFieldName("name")) {
      const alias = imported?.type === "aliased_import" ? imported.childForFieldName("alias")?.text : undefined;
      const name = imported?.type === "aliased_import" ? imported.childForFieldName("name")?.text : imported?.text;
      if (name && !name.includes(".")) out.set(alias ?? name, { fileId: moduleFile, name });
    }
  }
  return out;
}

const LITERAL_TYPES = new Set(["integer", "float", "true", "false", "none"]);

/** The source text of a literal argument; an f-string or a concatenation is not one. */
function literalText(arg: Node): string | null {
  if (LITERAL_TYPES.has(arg.type)) return arg.text;
  if (arg.type === "string") return arg.namedChildren.some((c) => c?.type === "interpolation") ? null : arg.text;
  if (arg.type === "unary_operator" && arg.text.startsWith("-")) {
    const operand = arg.childForFieldName("argument");
    return operand && (operand.type === "integer" || operand.type === "float") ? arg.text : null;
  }
  return null;
}

function pythonCallSite(argumentList: Node): CallSite {
  const site: CallSite = { args: [] };
  for (const arg of argumentList.namedChildren) {
    if (!arg || arg.type === "comment") continue;
    if (arg.type === "list_splat") site.spreadFrom ??= site.args.length;
    else if (arg.type === "dictionary_splat") site.kwSplat = true;
    else if (arg.type === "keyword_argument") addKeyword(site, arg);
    else if (site.spreadFrom === undefined) site.args.push(literalText(arg));
  }
  return site;
}

function addKeyword(site: CallSite, arg: Node): void {
  const name = arg.childForFieldName("name")?.text;
  const value = arg.childForFieldName("value");
  if (!name || !value) return;
  site.kwargs ??= {};
  site.kwargs[name] = literalText(value);
}
