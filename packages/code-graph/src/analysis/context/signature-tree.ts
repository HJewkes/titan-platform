import { parseSymbolId } from "../../extractors/ids.js";
import type { GraphNode } from "../../types.js";

/** Marks a gap between two symbols that are not adjacent in their file. */
export const ELISION_MARKER = "...";
/** Ends a line cut at `maxLineChars`; it counts toward the limit. */
export const TRUNCATION_SUFFIX = "…";
export const DEFAULT_MAX_LINE_CHARS = 120;

const INDENT = "  ";

export interface SignatureTreeOptions {
  maxLineChars?: number;
}

interface Entry {
  node: GraphNode;
  start?: number;
  end?: number;
  depth: number;
}

/**
 * Render symbols as a signatures-only tree for LLM context: per file (sorted by
 * path) a header line, then one line per symbol, with `ELISION_MARKER` between
 * symbols that are not adjacent. Pure; output is independent of input order.
 *
 * A line is the symbol's `attrs.signature`, else `<name> (<kind>)`. Symbols
 * order by `attrs.startLine`, then name, then id. A qualified name
 * (`Job.run`) indents one level per dot. Symbols with no `startLine`
 * (exported types and consts) render after the line-ordered ones, sorted by
 * name then id, and get no elision markers because their position is unknown.
 */
export function renderSignatureTree(
  nodes: readonly GraphNode[],
  options: SignatureTreeOptions = {},
): string {
  const max = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const lines: string[] = [];
  for (const [file, entries] of groupByFile(nodes)) {
    lines.push(truncate(file, max));
    for (const line of fileLines(entries)) lines.push(truncate(line, max));
  }
  return lines.join("\n");
}

function groupByFile(nodes: readonly GraphNode[]): [string, Entry[]][] {
  const byFile = new Map<string, Entry[]>();
  for (const node of nodes) {
    if (node.kind !== "symbol") continue;
    const parsed = parseSymbolId(node.id);
    const file = node.parentId ?? parsed?.fileId ?? node.id;
    const list = byFile.get(file) ?? [];
    list.push(toEntry(node, parsed?.name ?? node.name));
    byFile.set(file, list);
  }
  return [...byFile].sort(([a], [b]) => compare(a, b));
}

function toEntry(node: GraphNode, qualifiedName: string): Entry {
  const start = numberAttr(node, "startLine");
  const end = numberAttr(node, "endLine") ?? start;
  return { node, start, end, depth: qualifiedName.split(".").length - 1 };
}

function numberAttr(node: GraphNode, key: string): number | undefined {
  const value = node.attrs?.[key];
  return typeof value === "number" ? value : undefined;
}

function fileLines(entries: Entry[]): string[] {
  const ordered = entries.sort(compareEntries);
  const lines: string[] = [];
  let reach: number | undefined;
  for (const entry of ordered) {
    if (reach !== undefined && entry.start !== undefined && !adjacent(reach, entry.start)) {
      lines.push(ELISION_MARKER);
    }
    lines.push(INDENT.repeat(entry.depth) + symbolText(entry.node));
    if (entry.end !== undefined) reach = Math.max(reach ?? entry.end, entry.end);
  }
  return lines;
}

/** Adjacent: the next symbol starts at most one line after the furthest end so far. */
function adjacent(reach: number, nextStart: number): boolean {
  return nextStart <= reach + 1;
}

function symbolText(node: GraphNode): string {
  const signature = node.attrs?.signature;
  const text =
    typeof signature === "string" && signature !== ""
      ? signature
      : `${node.name} (${node.kind})`;
  return text.replace(/\s*\n\s*/g, " ");
}

function compareEntries(a: Entry, b: Entry): number {
  if (a.start !== b.start) {
    if (a.start === undefined) return 1;
    if (b.start === undefined) return -1;
    return a.start - b.start;
  }
  return compare(a.node.name, b.node.name) || compare(a.node.id, b.node.id);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function truncate(line: string, max: number): string {
  if (line.length <= max) return line;
  if (max <= TRUNCATION_SUFFIX.length) return TRUNCATION_SUFFIX.slice(0, Math.max(max, 0));
  return line.slice(0, max - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}
