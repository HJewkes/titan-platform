import { createReadStream } from "node:fs";

export interface RawLine {
  /** Absolute byte offset of the line's first byte within the file. */
  byteOffset: number;
  /** Byte length of the line, excluding its terminating newline. */
  byteLength: number;
  text: string;
}

const NEWLINE = 0x0a;

/**
 * Stream complete newline-terminated lines from `startOffset` with exact byte
 * offsets. The buffer is split by hand rather than via `readline`, which hides
 * the terminator and normalizes `\r\n`, so a byte cursor derived from its
 * output drifts on any file that is not pure LF.
 *
 * A trailing partial line (a file being appended to right now) is withheld so a
 * watermark advanced to `byteOffset + byteLength + 1` never lands mid-record.
 * `startOffset` must therefore be a line boundary.
 */
export async function* readJsonLines(filePath: string, startOffset = 0): AsyncGenerator<RawLine> {
  let pending = Buffer.alloc(0);
  let cursor = startOffset;

  for await (const chunk of createReadStream(filePath, { start: startOffset })) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    let newlineAt = pending.indexOf(NEWLINE);
    while (newlineAt !== -1) {
      const line = pending.subarray(0, newlineAt);
      yield { byteOffset: cursor, byteLength: line.length, text: line.toString("utf8") };
      cursor += newlineAt + 1;
      pending = pending.subarray(newlineAt + 1);
      newlineAt = pending.indexOf(NEWLINE);
    }
  }
}

/** The watermark a reader should store after consuming `line`: the byte after its newline. */
export function nextOffset(line: RawLine): number {
  return line.byteOffset + line.byteLength + 1;
}
