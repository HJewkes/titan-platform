import type { ParsedFile } from "@titan-design/code-parser";
import type { Node } from "web-tree-sitter";
import { forEachDeclaration } from "../declared-names.js";
import type { ParamShape } from "./call-sites.js";

const TS_PARAM_TYPES = new Set(["required_parameter", "optional_parameter"]);

/**
 * The parameter shape of every function and method a file declares, keyed by
 * qualified name. Classes carry none. From the same tree-sitter walk as the symbol
 * nodes, so a reused file's shapes ride forward on its symbol nodes unchanged.
 */
export function collectParamShapes(file: ParsedFile): Map<string, ParamShape> {
  const out = new Map<string, ParamShape>();
  forEachDeclaration(file, (_name, qualifiedName, node) => {
    const shape = file.language === "python" ? pythonShape(node) : tsShape(node);
    if (shape) out.set(qualifiedName, shape);
  });
  return out;
}

function tsShape(fn: Node): ParamShape | null {
  if (fn.type === "class_declaration") return null;
  const single = fn.childForFieldName("parameter");
  if (single) return { params: [single.text], positional: 1 };
  const params: string[] = [];
  for (const param of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (!param || !TS_PARAM_TYPES.has(param.type)) continue;
    const pattern = param.childForFieldName("pattern");
    if (!pattern || pattern.type === "this") continue;
    if (pattern.type === "rest_pattern") break;
    params.push(pattern.type === "identifier" ? pattern.text : `$${params.length}`);
  }
  return { params, positional: params.length };
}

function pythonShape(fn: Node): ParamShape | null {
  if (fn.type !== "function_definition") return null;
  const names: string[] = [];
  let positionalEnd: number | null = null;
  for (const param of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (!param) continue;
    if (param.type === "keyword_separator" || param.type === "list_splat_pattern") positionalEnd ??= names.length;
    const name = pythonParamName(param);
    if (name) names.push(name);
  }
  const receiver = hasReceiver(fn) && names.length > 0 ? 1 : 0;
  return { params: names.slice(receiver), positional: Math.max((positionalEnd ?? names.length) - receiver, 0) };
}

/** The bound name of a plain, typed or defaulted parameter; null for separators and `*args` / `**kw`. */
function pythonParamName(param: Node): string | null {
  if (param.type === "identifier") return param.text;
  if (param.type === "default_parameter" || param.type === "typed_default_parameter") {
    return param.childForFieldName("name")?.text ?? null;
  }
  if (param.type === "typed_parameter") {
    const first = param.namedChildren[0];
    return first?.type === "identifier" ? first.text : null;
  }
  return null;
}

/** A method defined directly in a class body takes `self` or `cls` first, unless it is a `@staticmethod`. */
export function hasReceiver(fn: Node): boolean {
  const decorated = fn.parent?.type === "decorated_definition" ? fn.parent : null;
  const block = (decorated ?? fn).parent;
  if (block?.type !== "block" || block.parent?.type !== "class_definition") return false;
  const decorators = decorated?.namedChildren.filter((c) => c?.type === "decorator") ?? [];
  return !decorators.some((d) => d?.text === "@staticmethod");
}
