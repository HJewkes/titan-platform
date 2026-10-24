import { splitLines, toBytes, type Line } from "./lines.js";

export interface BlockRange {
  /** Byte offset of the block's first byte. */
  start: number;
  /** Byte offset just past the block; the range is half-open. */
  end: number;
  /** 1-based line of the block's first line. */
  startLine: number;
  /** 1-based line of the block's last line, inclusive. */
  endLine: number;
}

export type Block =
  | (BlockRange & { kind: "frontmatter" | "paragraph" | "table" })
  | (BlockRange & { kind: "heading"; level: number; text: string })
  | (BlockRange & { kind: "fence"; closed: boolean });

export type BlockKind = Block["kind"];

interface Step {
  block?: Block;
  after: number;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_ROW = /^ {0,3}\|/;
const FRONTMATTER_OPEN = "---";
const FRONTMATTER_CLOSE = new Set(["---", "..."]);

/**
 * Scans markdown into top-level blocks with byte and line ranges. Blank lines between
 * blocks belong to no block. Offsets index the UTF-8 encoding of `source`.
 */
export function scanBlocks(source: string | Uint8Array): Block[] {
  const lines = splitLines(toBytes(source));
  const blocks: Block[] = [];
  let index = 0;
  const frontmatterLast = findFrontmatterEnd(lines);
  if (frontmatterLast !== -1) {
    blocks.push({ kind: "frontmatter", ...rangeOf(lines, 0, frontmatterLast) });
    index = frontmatterLast + 1;
  }
  while (index < lines.length) {
    const step = readBlock(lines, index);
    if (step.block) blocks.push(step.block);
    index = step.after;
  }
  return blocks;
}

function findFrontmatterEnd(lines: Line[]): number {
  if (lines[0]?.text.trimEnd() !== FRONTMATTER_OPEN) return -1;
  for (let index = 1; index < lines.length; index++) {
    if (FRONTMATTER_CLOSE.has(lines[index]!.text.trimEnd())) return index;
  }
  return -1;
}

function readBlock(lines: Line[], index: number): Step {
  const text = lines[index]!.text;
  if (isBlank(text)) return { after: index + 1 };
  const heading = HEADING.exec(text);
  if (heading) {
    const block: Block = {
      kind: "heading",
      level: heading[1]!.length,
      text: (heading[2] ?? "").trim(),
      ...rangeOf(lines, index, index),
    };
    return { block, after: index + 1 };
  }
  const fence = fenceMarker(text);
  if (fence) return readFence(lines, index, fence);
  if (TABLE_ROW.test(text)) return readRun(lines, index, "table", (line) => TABLE_ROW.test(line));
  return readRun(lines, index, "paragraph", continuesParagraph);
}

function readFence(lines: Line[], index: number, marker: string): Step {
  for (let last = index + 1; last < lines.length; last++) {
    if (closesFence(lines[last]!.text, marker)) {
      return { block: fenceBlock(lines, index, last, true), after: last + 1 };
    }
  }
  return { block: fenceBlock(lines, index, lines.length - 1, false), after: lines.length };
}

function fenceBlock(lines: Line[], first: number, last: number, closed: boolean): Block {
  return { kind: "fence", closed, ...rangeOf(lines, first, last) };
}

function readRun(
  lines: Line[],
  index: number,
  kind: "paragraph" | "table",
  continues: (text: string) => boolean,
): Step {
  let last = index;
  while (last + 1 < lines.length && continues(lines[last + 1]!.text)) last++;
  return { block: { kind, ...rangeOf(lines, index, last) }, after: last + 1 };
}

function continuesParagraph(text: string): boolean {
  return !isBlank(text) && !HEADING.test(text) && !fenceMarker(text) && !TABLE_ROW.test(text);
}

/** The opening run of a fence, or null. A backtick fence's info string may not hold a backtick. */
function fenceMarker(text: string): string | null {
  const match = FENCE_OPEN.exec(text);
  if (!match) return null;
  const marker = match[1]!;
  if (marker.startsWith("`") && match[2]!.includes("`")) return null;
  return marker;
}

function closesFence(text: string, marker: string): boolean {
  const run = /^ {0,3}(`+|~+)[ \t]*$/.exec(text)?.[1];
  return run !== undefined && run[0] === marker[0] && run.length >= marker.length;
}

function rangeOf(lines: Line[], first: number, last: number): BlockRange {
  return {
    start: lines[first]!.start,
    end: lines[last]!.end,
    startLine: first + 1,
    endLine: last + 1,
  };
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}
