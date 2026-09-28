import type { Node } from "web-tree-sitter";
import { bodyStatements } from "./comment-lines.js";

/**
 * Pass-through functions (TP-322): the body is one call that forwards every
 * parameter, in order, as a bare argument, as in `def load(path): return read(path)`.
 * Only the exact case is claimed; a keyword argument, a reordering, a dropped or
 * transformed parameter, or a function with no parameters at all is not a pass-through.
 */

const RECEIVERS = new Set(["self", "cls"]);
const CALL_TYPES = new Set(["call", "call_expression"]);
const WRAPPER_TYPES = new Set(["return_statement", "expression_statement"]);
const PY_NAMED_PARAMS = new Set(["default_parameter", "typed_default_parameter"]);
const PY_SEPARATORS = new Set(["keyword_separator", "positional_separator"]);

export function isPassThrough(fn: Node, body: Node): boolean {
  const call = soleCall(body);
  if (!call) return false;
  const params = parameterShapes(fn);
  if (!params || params.length === 0) return false;
  const args = argumentShapes(call);
  return args !== null && args.length === params.length && args.every((a, i) => a === params[i]);
}

function soleCall(body: Node): Node | null {
  const statements = bodyStatements(body);
  if (statements.length !== 1) return null;
  const only = statements[0]!;
  if (CALL_TYPES.has(only.type)) return only;
  if (!WRAPPER_TYPES.has(only.type) || only.namedChildCount !== 1) return null;
  const value = only.namedChildren[0]!;
  return CALL_TYPES.has(value.type) ? value : null;
}

/** Each parameter as the argument text that forwards it (`a`, `*args`, `...rest`), or null when one cannot be forwarded bare. */
function parameterShapes(fn: Node): string[] | null {
  const bare = fn.childForFieldName("parameter");
  if (bare) return [bare.text];
  const list = fn.childForFieldName("parameters");
  if (!list) return null;
  const shapes: string[] = [];
  for (const p of list.namedChildren) {
    if (!p || p.type === "comment" || PY_SEPARATORS.has(p.type)) continue;
    const shape = parameterShape(p);
    if (shape === null) return null;
    shapes.push(shape);
  }
  return RECEIVERS.has(shapes[0] ?? "") ? shapes.slice(1) : shapes;
}

function parameterShape(p: Node): string | null {
  if (p.type === "identifier") return p.text;
  if (p.type === "list_splat_pattern" || p.type === "dictionary_splat_pattern") return p.text;
  if (PY_NAMED_PARAMS.has(p.type)) return p.childForFieldName("name")?.text ?? null;
  if (p.type === "typed_parameter") return parameterShape(p.namedChildren[0]!);
  if (p.type === "required_parameter" || p.type === "optional_parameter") {
    const pattern = p.childForFieldName("pattern");
    return pattern ? tsPatternShape(pattern) : null;
  }
  return tsPatternShape(p);
}

function tsPatternShape(pattern: Node): string | null {
  if (pattern.type === "identifier") return pattern.text;
  if (pattern.type === "rest_pattern") return `...${pattern.namedChildren[0]?.text ?? ""}`;
  if (pattern.type === "assignment_pattern") {
    const left = pattern.childForFieldName("left");
    return left ? tsPatternShape(left) : null;
  }
  return null;
}

function argumentShapes(call: Node): string[] | null {
  const list = call.childForFieldName("arguments");
  if (!list || (list.type !== "argument_list" && list.type !== "arguments")) return null;
  const shapes: string[] = [];
  for (const a of list.namedChildren) {
    if (!a || a.type === "comment") continue;
    const shape = argumentShape(a);
    if (shape === null) return null;
    shapes.push(shape);
  }
  return shapes;
}

function argumentShape(a: Node): string | null {
  if (a.type === "identifier") return a.text;
  const inner = a.namedChildren[0];
  if (inner?.type !== "identifier") return null;
  if (a.type === "list_splat") return `*${inner.text}`;
  if (a.type === "dictionary_splat") return `**${inner.text}`;
  if (a.type === "spread_element") return `...${inner.text}`;
  return null;
}
