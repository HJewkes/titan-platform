import { parseHeader } from "./header.js";

export interface ParagraphSpan {
  /** Zero-based position among the document's paragraphs. */
  index: number;
  /** UTF-8 byte range in the file, so the exact paragraph is re-read with a buffer slice. */
  byteOffset: number;
  byteLength: number;
  text: string;
}

const BREAK = /\r?\n(?:[ \t]*\r?\n)+/g;

/** Paragraphs of the body, split on blank lines, with byte ranges into the whole file. */
export function splitParagraphs(text: string): ParagraphSpan[] {
  const { bodyStart } = parseHeader(text);
  const spans: ParagraphSpan[] = [];
  let charPos = bodyStart;
  let bytePos = Buffer.byteLength(text.slice(0, bodyStart));
  const push = (end: number): void => {
    const slice = text.slice(charPos, end);
    const trimmed = slice.trim();
    if (trimmed.length === 0) return;
    const lead = slice.length - slice.trimStart().length;
    const byteOffset = bytePos + Buffer.byteLength(slice.slice(0, lead));
    spans.push({ index: spans.length, byteOffset, byteLength: Buffer.byteLength(trimmed), text: trimmed });
  };
  const body = text.slice(bodyStart);
  for (const gap of body.matchAll(BREAK)) {
    const end = bodyStart + gap.index;
    push(end);
    const next = end + gap[0].length;
    bytePos += Buffer.byteLength(text.slice(charPos, next));
    charPos = next;
  }
  push(text.length);
  return spans;
}
