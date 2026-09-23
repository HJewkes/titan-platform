import type { Node } from "web-tree-sitter";
import { functionComments } from "./comment-lines.js";

/**
 * Narrating comments (TP-322): a comment inside a function body that restates
 * the statement right after it, such as `// increment the retry count` above
 * `retryCount += 1`. A candidate signal, not a verdict: the match is a plain
 * token overlap, deterministic and cheap.
 */

const MIN_SHARED = 2;
const MIN_SHARE_OF_COMMENT = 0.5;

const STOPWORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "into", "then", "else", "when", "not",
  "are", "was", "has", "have", "its", "our", "all", "any", "can", "will", "just", "now",
  "return", "const", "let", "var", "def", "self", "none", "true", "false", "null", "undefined",
  "new", "await", "async", "function",
]);

const IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "type_identifier",
]);

export function countNarratingComments(fn: Node, body: Node): number {
  let count = 0;
  for (const comment of functionComments(fn, body)) {
    const target = trailedStatement(comment) ?? nextStatement(comment);
    if (target && narrates(comment.text, target)) count++;
  }
  return count;
}

/** A comment on the same row as the end of the statement before it describes that statement. */
function trailedStatement(comment: Node): Node | null {
  const prev = comment.previousNamedSibling;
  if (!prev || prev.type === "comment") return null;
  return prev.endPosition.row === comment.startPosition.row ? prev : null;
}

/** Lowercased word tokens of length 3 or more, split on non-word characters, underscores and camelCase humps. */
export function identifierTokens(text: string): Set<string> {
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/);
  const out = new Set<string>();
  for (const w of words) {
    const t = w.toLowerCase();
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** A run of comment rows describes the first statement below it, inside the block a Python comment sits beside. */
function nextStatement(comment: Node): Node | null {
  let next = comment.nextNamedSibling;
  while (next?.type === "comment") next = next.nextNamedSibling;
  if (next?.type !== "block") return next;
  return next.namedChildren.find((c) => c !== null && c.type !== "comment") ?? null;
}

function narrates(commentText: string, statement: Node): boolean {
  const said = identifierTokens(commentText);
  if (said.size === 0) return false;
  const code = identifierTokens(statementIdentifiers(statement).join(" "));
  let shared = 0;
  for (const t of said) if (code.has(t)) shared++;
  return shared >= MIN_SHARED || shared / said.size >= MIN_SHARE_OF_COMMENT;
}

function statementIdentifiers(statement: Node): string[] {
  const out: string[] = [];
  const visit = (node: Node): void => {
    if (IDENTIFIER_TYPES.has(node.type)) out.push(node.text);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(statement);
  return out;
}
