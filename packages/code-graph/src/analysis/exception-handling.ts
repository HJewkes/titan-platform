import type { Node } from "web-tree-sitter";
import type { GraphMetric } from "../types.js";
import { bodyStatements, descendantsOfType } from "./comment-lines.js";
import { identifierTokens } from "./narrating-comments.js";

/**
 * Exception-handling metrics (TP-322), pure functions of one file's bytes. A
 * handler is swallowed when all it does is nothing, skip, bail out empty, or
 * log: the error stops here and no caller learns of it. Written on every file,
 * zeros included, so percentiles over a snapshot see the clean files too.
 */
export const EXCEPTION_METRIC_NAMES: readonly string[] = ["except_count", "except_density", "swallowed_except"];

const HANDLER_TYPES = ["except_clause", "except_group_clause", "catch_clause"];
const SILENT_STATEMENTS = new Set(["pass_statement", "continue_statement", "empty_statement"]);
const EMPTY_VALUES = new Set(["None", "null", "undefined"]);
const LOGGING_TOKENS = new Set(["log", "logger", "logging", "warn", "warning", "warnings", "print", "console"]);
const EXCEPT_CLAUSE_TYPES = new Set(["except_clause", "except_group_clause"]);
const OPTIONAL_IMPORT_EXCEPT_TYPES = new Set(["ImportError", "ModuleNotFoundError"]);

export function exceptionMetrics(nodeId: string, root: Node, loc: number): GraphMetric[] {
  const handlers = HANDLER_TYPES.flatMap((type) => descendantsOfType(root, type));
  const swallowed = handlers.filter((h) => isSwallowed(h)).length;
  return [
    { nodeId, name: "except_count", value: handlers.length, unit: "count" },
    { nodeId, name: "except_density", value: loc === 0 ? 0 : (handlers.length * 100) / loc, unit: "per100loc" },
    { nodeId, name: "swallowed_except", value: swallowed, unit: "count" },
  ];
}

function isSwallowed(handler: Node): boolean {
  if (isOptionalImportExcept(handler)) return false;
  const body = handler.childForFieldName("body") ?? handler.namedChildren.find((c) => c?.type === "block");
  if (!body) return false;
  const statements = bodyStatements(body, null);
  if (statements.length === 0) return true;
  return statements.length === 1 && isSilent(statements[0]!);
}

/**
 * True for `except ImportError`, `except ModuleNotFoundError`, or a tuple of only
 * those two (with an optional `as name`) — the standard optional-dependency idiom,
 * never counted as swallowed regardless of what the body does.
 */
function isOptionalImportExcept(handler: Node): boolean {
  if (!EXCEPT_CLAUSE_TYPES.has(handler.type)) return false;
  const value = handler.childForFieldName("value");
  if (!value) return false;
  const typeExpr = value.type === "as_pattern" ? value.namedChild(0) : value;
  if (!typeExpr) return false;
  if (typeExpr.type === "identifier") return OPTIONAL_IMPORT_EXCEPT_TYPES.has(typeExpr.text);
  if (typeExpr.type !== "tuple") return false;
  const names = typeExpr.namedChildren.filter((c): c is Node => c !== null);
  return names.length > 0 && names.every((n) => n.type === "identifier" && OPTIONAL_IMPORT_EXCEPT_TYPES.has(n.text));
}

function isSilent(statement: Node): boolean {
  if (SILENT_STATEMENTS.has(statement.type)) return true;
  const value = statement.namedChildren[0];
  if (statement.type === "return_statement") return !value || EMPTY_VALUES.has(value.text);
  if (statement.type !== "expression_statement" || !value) return false;
  if (value.type === "ellipsis") return true;
  return isLoggingCall(value);
}

function isLoggingCall(node: Node): boolean {
  if (node.type !== "call" && node.type !== "call_expression") return false;
  const callee = node.childForFieldName("function");
  if (!callee) return false;
  for (const token of identifierTokens(callee.text)) if (LOGGING_TOKENS.has(token)) return true;
  return false;
}
