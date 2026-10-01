import { open } from "node:fs/promises";
import { readTranscriptEvents } from "@titan-design/session-read";

/** An ended agent whose last event is at least this old has lost its prompt cache, so a successor costs no more. */
export const WARM_MINUTES = 50;
/** An ended agent holding this many context tokens or more is not resumed. */
export const MAX_FILL = 200_000;
/** How much of a transcript's end is read; the last request of a session sits well inside it. */
export const TAIL_BYTES = 256 * 1024;

export interface Warmth {
  /** Epoch milliseconds of the newest event read. */
  lastEventAt: number;
  /** Context tokens the last main-thread request reported: input plus cache read plus cache creation. */
  fill: number;
}

export interface WarmthLimits {
  warmMinutes: number;
  maxFill: number;
}

export const DEFAULT_WARMTH_LIMITS: WarmthLimits = { warmMinutes: WARM_MINUTES, maxFill: MAX_FILL };

/** An unknown warmth is never warm, so an unreadable transcript gets a successor rather than a blind resume. */
export function isWarm(warmth: Warmth | undefined, now: number, limits: WarmthLimits = DEFAULT_WARMTH_LIMITS): boolean {
  if (warmth === undefined) return false;
  return now - warmth.lastEventAt < limits.warmMinutes * 60_000 && warmth.fill < limits.maxFill;
}

/** Reads the transcript's tail; undefined when the file is missing, malformed, or holds no dated event and request there. */
export async function readWarmth(transcriptPath: string, tailBytes = TAIL_BYTES): Promise<Warmth | undefined> {
  try {
    const fromByteOffset = await tailLineStart(transcriptPath, tailBytes);
    let lastEventAt: number | undefined;
    let fill: number | undefined;
    for await (const event of readTranscriptEvents(transcriptPath, { fromByteOffset })) {
      const at = Date.parse(event.ts);
      if (Number.isFinite(at)) lastEventAt = Math.max(lastEventAt ?? at, at);
      if (event.kind === "request" && !event.isSidechain) fill =event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens;
    }
    return lastEventAt === undefined || fill === undefined ? undefined : { lastEventAt, fill };
  } catch {
    return undefined;
  }
}

/** The first line boundary at or after `size - tailBytes`, because a read must start on a line. */
async function tailLineStart(path: string, tailBytes: number): Promise<number> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size <= tailBytes) return 0;
    const from = size - tailBytes;
    const buffer = Buffer.alloc(tailBytes);
    const { bytesRead } = await handle.read(buffer, 0, tailBytes, from - 1);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    return newline === -1 ? size : from + newline;
  } finally {
    await handle.close();
  }
}
