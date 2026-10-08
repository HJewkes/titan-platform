import { createHash } from "node:crypto";
import type { LocatedSourceLine, ResumeBoundary } from "./normalized.js";
import { TranscriptParseError } from "./read.js";
import { asObject, type Json } from "./text.js";

/** Receives each non-blank line with the verified prefix boundary that precedes it. */
type HandleDecodedLine = (line: LocatedSourceLine, before: ResumeBoundary) => void;

/** Replay every line into the prefix digest so the returned boundary covers exactly what was read. */
export async function decodeLines(lines: AsyncIterable<LocatedSourceLine>, handle: HandleDecodedLine): Promise<ResumeBoundary> {
  const digest = createHash("sha256");
  let boundary = boundaryAt(0, digest);
  for await (const line of lines) {
    if (line.raw.trim().length > 0) handle(line, boundaryAt(line.evidence.byteOffset, digest));
    digest.update(line.raw, "utf8").update("\n");
    boundary = boundaryAt(line.evidence.byteOffset + line.evidence.byteLength + 1, digest);
  }
  return boundary;
}

function boundaryAt(byteOffset: number, digest: ReturnType<typeof createHash>): ResumeBoundary {
  return { byteOffset, prefixHash: digest.copy().digest("hex") };
}

export function parseRecord(filePath: string, line: LocatedSourceLine): Json {
  try {
    const parsed = asObject(JSON.parse(line.raw));
    if (!parsed) throw new TypeError("record is not an object");
    return parsed;
  } catch (error) {
    throw new TranscriptParseError(filePath, line.evidence.byteOffset, error);
  }
}
