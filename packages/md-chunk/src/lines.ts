export interface Line {
  /** Byte offset of the first byte of the line. */
  start: number;
  /** Byte offset just past the line's `\n`, or the byte length for a last line without one. */
  end: number;
  /** The decoded line without its `\r\n` or `\n`. */
  text: string;
}

const NEWLINE = 0x0a;

export function toBytes(source: string | Uint8Array): Uint8Array {
  return typeof source === "string" ? new TextEncoder().encode(source) : source;
}

/** Splits on `\n` bytes only, so a `\r` stays inside the line's byte range and offsets stay exact. */
export function splitLines(bytes: Uint8Array): Line[] {
  const decoder = new TextDecoder();
  const lines: Line[] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline === -1 ? bytes.length : newline + 1;
    const text = decoder.decode(bytes.subarray(start, end)).replace(/\r?\n?$/, "");
    lines.push({ start, end, text });
    start = end;
  }
  return lines;
}
