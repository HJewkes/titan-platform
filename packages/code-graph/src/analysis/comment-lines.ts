import type { Node } from "web-tree-sitter";

/**
 * Comment, docstring and code line counts for one function (TP-322). Lines are
 * counted as distinct source rows, so two comments on one row count once. The
 * docstring is documentation, not narration: it counts toward neither comment
 * nor body lines.
 */
export interface CommentLineStats {
  commentLines: number;
  docstringLines: number;
  bodyLines: number;
  commentRatio: number;
}

/** `fn` is the function node, `body` its body, `lines` the file's content split on newlines. */
export function commentLineStats(fn: Node, body: Node, lines: readonly string[]): CommentLineStats {
  const docstring = pythonDocstring(body);
  const comments = functionComments(fn, body);
  const commentLines = rowsOf(comments).size;
  const bodyLines = codeRows(body, docstring, comments, lines);
  return {
    commentLines,
    docstringLines: docstring ? rowSpan(docstring) : jsDocLines(fn),
    bodyLines,
    commentRatio: commentLines / Math.max(bodyLines, 1),
  };
}

/** The leading string statement of a Python block, which Python binds to `__doc__`. */
export function pythonDocstring(body: Node): Node | null {
  if (body.type !== "block") return null;
  const first = body.namedChildren.find((c) => c !== null && c.type !== "comment");
  if (first?.type !== "expression_statement" || first.namedChildCount !== 1) return null;
  return first.namedChildren[0]?.type === "string" ? first : null;
}

/** Statements of the body, docstring and comments aside; an expression-bodied arrow is its own statement. */
export function bodyStatements(body: Node, docstring: Node | null = pythonDocstring(body)): Node[] {
  if (body.type !== "block" && body.type !== "statement_block") return [body];
  return body.namedChildren.filter(
    (c): c is Node => c !== null && c.type !== "comment" && c.id !== docstring?.id,
  );
}

/** Python parses a block's leading comment as the block's sibling, so its comments are taken from the whole def after the signature. */
export function functionComments(fn: Node, body: Node): Node[] {
  if (body.type !== "block") return descendantsOfType(body, "comment");
  const signatureEnd = fn.childForFieldName("parameters")?.endIndex ?? body.startIndex;
  return descendantsOfType(fn, "comment").filter((c) => c.startIndex >= signatureEnd);
}

export function descendantsOfType(root: Node, type: string): Node[] {
  const out: Node[] = [];
  const visit = (node: Node): void => {
    if (node.type === type) out.push(node);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return out;
}

function rowSpan(node: Node): number {
  return node.endPosition.row - node.startPosition.row + 1;
}

function rowsOf(nodes: readonly Node[]): Set<number> {
  const rows = new Set<number>();
  for (const n of nodes) {
    for (let r = n.startPosition.row; r <= n.endPosition.row; r++) rows.add(r);
  }
  return rows;
}

/** Rows under the body's statements that still hold code once comments are blanked out. */
function codeRows(body: Node, docstring: Node | null, comments: readonly Node[], lines: readonly string[]): number {
  let count = 0;
  for (const row of rowsOf(bodyStatements(body, docstring))) {
    if (codeOnRow(row, lines[row] ?? "", comments).trim() !== "") count++;
  }
  return count;
}

function codeOnRow(row: number, text: string, comments: readonly Node[]): string {
  let out = text;
  for (const c of comments) {
    if (row < c.startPosition.row || row > c.endPosition.row) continue;
    const from = row === c.startPosition.row ? c.startPosition.column : 0;
    const to = row === c.endPosition.row ? c.endPosition.column : out.length;
    out = out.slice(0, from) + " ".repeat(Math.max(to - from, 0)) + out.slice(to);
  }
  return out;
}

/** A `/** … *\/` block ending on the row above the declaration, or on its first row. */
function jsDocLines(fn: Node): number {
  const anchor = declarationAnchor(fn);
  const prev = anchor.previousNamedSibling;
  if (prev?.type !== "comment" || !prev.text.startsWith("/**")) return 0;
  const gap = anchor.startPosition.row - prev.endPosition.row;
  return gap === 0 || gap === 1 ? rowSpan(prev) : 0;
}

/** The node a JSDoc block sits beside: the `const` or `export` wrapping a function, not the function itself. */
function declarationAnchor(fn: Node): Node {
  let anchor = fn;
  if (fn.parent?.type === "variable_declarator") anchor = fn.parent.parent ?? fn;
  while (anchor.parent?.type === "export_statement") anchor = anchor.parent;
  return anchor;
}
