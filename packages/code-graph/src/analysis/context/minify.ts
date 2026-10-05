import type { Node, Point } from "web-tree-sitter";
import { parseFile } from "@titan-design/code-parser";
import { bodyStatements, descendantsOfType, pythonDocstring } from "../comment-lines.js";

export type MinifyLanguage = "typescript" | "tsx" | "python";

/**
 * Minified source plus its line map. `lineMap[i]` is the 1-based original line
 * of output line `i + 1`; `originalLine` reads it by output line number.
 */
export interface MinifiedSource {
  text: string;
  lineMap: number[];
}

interface OutputLine {
  text: string;
  line: number;
  /** A row inside a multi-line string: its whitespace is content, so it is neither trimmed nor collapsed. */
  verbatim: boolean;
}

/** A removed column range on one row; `pad` keeps the columns as spaces so code after a multi-line comment keeps its indent. */
interface Cut {
  from: number;
  to: number;
  pad: boolean;
}

/** A removed source range: a node, or a docstring with its trailing `;`. */
interface Span {
  start: Point;
  end: Point;
}

interface ImportBlock {
  startRow: number;
  endRow: number;
  count: number;
}

const IMPORT_TYPES: Record<MinifyLanguage, ReadonlySet<string>> = {
  typescript: new Set(["import_statement"]),
  tsx: new Set(["import_statement"]),
  python: new Set(["import_statement", "import_from_statement", "future_import_statement"]),
};

/** Characters that end a token on their own, so nothing fuses across them. */
const DELIMITERS: ReadonlySet<string> = new Set(["(", ")", "[", "]", "{", "}", ",", ";"]);

const STRING_TYPES: Record<MinifyLanguage, readonly string[]> = {
  typescript: ["string", "template_string"],
  tsx: ["string", "template_string"],
  python: ["string"],
};

/** The one line that stands in for a leading import block. */
export function importMarker(count: number, language: MinifyLanguage): string {
  const prefix = language === "python" ? "#" : "//";
  return `${prefix} … ${count} import${count === 1 ? "" : "s"}`;
}

/** The 1-based original line of a 1-based output line, or undefined past the end. */
export function originalLine(minified: MinifiedSource, outputLine: number): number | undefined {
  return minified.lineMap[outputLine - 1];
}

export function isMinifyLanguage(language: string): language is MinifyLanguage {
  return language === "typescript" || language === "tsx" || language === "python";
}

/**
 * Safe-minify source for LLM context: drops comments and docstrings, strips
 * trailing whitespace, collapses blank-line runs and replaces a leading import
 * block with `importMarker`. It never renames or dedents, so every kept line is
 * its original line minus comments. Any other language comes back unchanged
 * with an identity line map.
 */
export async function minifySource(text: string, language: string): Promise<MinifiedSource> {
  if (!isMinifyLanguage(language)) return unchanged(text);
  const { tree } = await parseFile(text, "source", language);
  try {
    return minifyTree(tree.rootNode, text, language);
  } finally {
    tree.delete();
  }
}

/** The tree lives in WASM memory, so `minifySource` owns it and deletes it once this returns. */
function minifyTree(root: Node, text: string, language: MinifyLanguage): MinifiedSource {
  const rows = text.split("\n");
  const cuts = cutsByRow(removedSpans(root, language));
  const verbatim = verbatimRows(root, language);
  const block = leadingImportBlock(root, language);
  const out: OutputLine[] = [];
  for (let row = 0; row < rows.length; row++) {
    if (block && row >= block.startRow && row <= block.endRow) {
      if (row === block.startRow) out.push({ text: importMarker(block.count, language), line: row + 1, verbatim: false });
      continue;
    }
    const kept = keepRow(rows[row] ?? "", cuts.get(row), verbatim.has(row));
    if (kept !== null) out.push({ text: kept, line: row + 1, verbatim: verbatim.has(row) });
  }
  return finish(collapseBlanks(out), text.endsWith("\n"));
}

function unchanged(text: string): MinifiedSource {
  const rows = text.split("\n");
  const count = text === "" ? 0 : text.endsWith("\n") ? rows.length - 1 : rows.length;
  return { text, lineMap: Array.from({ length: count }, (_, i) => i + 1) };
}

function removedSpans(root: Node, language: MinifyLanguage): Span[] {
  const comments = descendantsOfType(root, "comment");
  if (language !== "python") {
    return [...comments, ...descendantsOfType(root, "hash_bang_line"), ...jsxCommentExpressions(root)].map(spanOf);
  }
  return [...comments.map(spanOf), ...pythonDocstrings(root).map(docstringSpan)];
}

function spanOf(node: Node): Span {
  return { start: node.startPosition, end: node.endPosition };
}

/** `"""doc""";` alone on its row: the `;` goes with the docstring, or the row keeps a bare `;`. */
function docstringSpan(docstring: Node): Span {
  const semicolon = docstring.nextSibling;
  const sameRow = semicolon?.type === ";" && semicolon.startPosition.row === docstring.endPosition.row;
  return { start: docstring.startPosition, end: sameRow ? semicolon.endPosition : docstring.endPosition };
}

/** `{/* … *\/}` in JSX: removing only the comment would leave an empty `{}` behind. */
function jsxCommentExpressions(root: Node): Node[] {
  return descendantsOfType(root, "jsx_expression").filter(
    (n) => n.namedChildCount > 0 && n.namedChildren.every((c) => c?.type === "comment"),
  );
}

function pythonDocstrings(root: Node): Node[] {
  const bodies = [...descendantsOfType(root, "class_definition"), ...descendantsOfType(root, "function_definition")]
    .map((def) => def.childForFieldName("body"))
    .filter((body): body is Node => body !== null);
  const docstrings = bodies.map((body) => droppableDocstring(body));
  const module = moduleDocstring(root);
  return [module && !sharesEndRow(module) ? module : null, ...docstrings].filter((d): d is Node => d !== null);
}

/** A docstring that is a body's only statement stays, or the body would be an empty suite. */
function droppableDocstring(body: Node): Node | null {
  const docstring = pythonDocstring(body);
  if (!docstring || bodyStatements(body, docstring).length === 0) return null;
  return sharesEndRow(docstring) ? null : docstring;
}

/** `"""doc"""; x = 1`: dropping the docstring would leave a stray `;` before the statement. */
function sharesEndRow(docstring: Node): boolean {
  let next = docstring.nextNamedSibling;
  while (next?.type === "comment") next = next.nextNamedSibling;
  return next?.startPosition.row === docstring.endPosition.row;
}

/** `pythonDocstring` reads a `block`; a module's docstring is the same leading string statement on the root. */
function moduleDocstring(root: Node): Node | null {
  const first = root.namedChildren.find((c) => c !== null && c.type !== "comment");
  if (first?.type !== "expression_statement" || first.namedChildCount !== 1) return null;
  return first.namedChildren[0]?.type === "string" ? first : null;
}

function cutsByRow(spans: readonly Span[]): Map<number, Cut[]> {
  const cuts = new Map<number, Cut[]>();
  for (const { start, end } of spans) {
    for (let row = start.row; row <= end.row; row++) {
      const from = row === start.row ? start.column : 0;
      const to = row === end.row ? end.column : Number.MAX_SAFE_INTEGER;
      const list = cuts.get(row) ?? [];
      list.push({ from, to, pad: row !== start.row });
      cuts.set(row, list);
    }
  }
  return cuts;
}

/** Rows whose line break sits inside a string: the string's own content runs on past them. */
function verbatimRows(root: Node, language: MinifyLanguage): Set<number> {
  const rows = new Set<number>();
  for (const type of STRING_TYPES[language]) {
    for (const s of descendantsOfType(root, type)) {
      for (let row = s.startPosition.row; row < s.endPosition.row; row++) rows.add(row);
    }
  }
  return rows;
}

/** The row with its cuts applied, or null when cuts left nothing but whitespace. */
function keepRow(row: string, cuts: readonly Cut[] | undefined, verbatim: boolean): string | null {
  if (!cuts) return verbatim ? row : row.trimEnd();
  let kept = "";
  let cutSinceKept = false;
  for (let col = 0; col < row.length; col++) {
    const hits = cuts.filter((c) => col >= c.from && col < c.to);
    const char = row[col] ?? "";
    if (hits.length === 0) {
      if (cutSinceKept && wouldFuse(kept.at(-1) ?? " ", char)) kept += " ";
      kept += char;
      cutSinceKept = false;
    } else if (hits.every((c) => c.pad)) kept += " ";
    else cutSinceKept = true;
  }
  const trimmed = kept.trimEnd();
  if (trimmed === "") return null;
  return verbatim ? kept : trimmed;
}

/** `typeof/**\/x` or `a +/**\/+b`: closing the gap would join two tokens into one, so one space stands in. */
function wouldFuse(before: string, after: string): boolean {
  return /\S/.test(before) && /\S/.test(after) && !DELIMITERS.has(before) && !DELIMITERS.has(after);
}

function leadingImportBlock(root: Node, language: MinifyLanguage): ImportBlock | null {
  const children = root.namedChildren.filter((c): c is Node => c !== null);
  const docstring = language === "python" ? moduleDocstring(root) : null;
  let i = 0;
  while (i < children.length && isPreamble(children[i] as Node, docstring)) i++;
  const imports: Node[] = [];
  for (; i < children.length; i++) {
    const child = children[i] as Node;
    if (child.type === "comment") continue;
    if (!IMPORT_TYPES[language].has(child.type)) break;
    imports.push(child);
  }
  while (docstring && imports[0]?.startPosition.row === docstring.endPosition.row) imports.shift();
  const next = children[i];
  while (next && imports.length > 0 && imports[imports.length - 1]?.endPosition.row === next.startPosition.row) imports.pop();
  const first = imports[0];
  const last = imports[imports.length - 1];
  if (!first || !last) return null;
  return { startRow: first.startPosition.row, endRow: last.endPosition.row, count: imports.length };
}

function isPreamble(node: Node, docstring: Node | null): boolean {
  return node.type === "comment" || node.type === "hash_bang_line" || node.id === docstring?.id;
}

/** Collapses each blank run to one blank line and drops blanks at either end. */
function collapseBlanks(lines: readonly OutputLine[]): OutputLine[] {
  const out: OutputLine[] = [];
  for (const line of lines) {
    const blank = line.text === "" && !line.verbatim;
    const prev = out[out.length - 1];
    if (blank && (!prev || (prev.text === "" && !prev.verbatim))) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]?.text === "" && !out[out.length - 1]?.verbatim) out.pop();
  return out;
}

function finish(lines: readonly OutputLine[], trailingNewline: boolean): MinifiedSource {
  const body = lines.map((l) => l.text).join("\n");
  return {
    text: trailingNewline && lines.length > 0 ? `${body}\n` : body,
    lineMap: lines.map((l) => l.line),
  };
}
