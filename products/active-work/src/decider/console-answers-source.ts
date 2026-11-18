import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  LedgerRowSchema,
  type LedgerRowWire,
  type LedgerSource,
  type SourceRead,
  type SourceWatermark,
  type SourceWatermarks,
} from '@titan-design/decider';

/**
 * Precedents from the titan console's `answers.jsonl`: one decider ledger row per owner
 * answer the console routed. The console only appends, so a watermark whose prefix hash
 * still matches lets a read parse just the bytes after it; any other change re-reads the
 * whole file, and the ledger's key dedup keeps rows it already holds.
 */

const CONSOLE_ANSWERS_SOURCE = 'console-answers';

function prefixHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Bytes past the watermark, or the whole file when its prefix no longer matches. */
function unreadStart(bytes: Buffer, since: SourceWatermark | undefined): number {
  if (since === undefined || since.offset > bytes.length) return 0;
  return prefixHash(bytes.subarray(0, since.offset)) === since.prefixHash ? since.offset : 0;
}

/** Stops at the last newline, so a row the console is still writing waits for the next read. */
function completeLength(bytes: Buffer, start: number): number {
  return bytes.lastIndexOf(0x0a) + 1 || start;
}

/** The row is kept as written, the console's extra keys included; the schema only vouches for it. */
function isLedgerRowWire(value: unknown): value is LedgerRowWire {
  return LedgerRowSchema.safeParse(value).success;
}

function parseRow(line: string): LedgerRowWire | null {
  try {
    const wire: unknown = JSON.parse(line);
    return isLedgerRowWire(wire) ? wire : null;
  } catch {
    return null;
  }
}

function parseRows(text: string): { rows: LedgerRowWire[]; malformed: number } {
  const out = { rows: [] as LedgerRowWire[], malformed: 0 };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const row = parseRow(line);
    if (row === null) out.malformed += 1;
    else out.rows.push(row);
  }
  return out;
}

export function consoleAnswersSource(answersPath: string): LedgerSource {
  return {
    name: CONSOLE_ANSWERS_SOURCE,
    async read(since: SourceWatermarks): Promise<SourceRead> {
      const out: SourceRead = { candidates: [], watermarks: new Map(), pending: 0, errors: [] };
      const bytes = await fs.readFile(answersPath).catch(() => null);
      if (bytes === null) return out;
      const start = unreadStart(bytes, since.get(answersPath));
      const end = completeLength(bytes, start);
      if (end === start) return out;
      const { rows, malformed } = parseRows(bytes.subarray(start, end).toString('utf8'));
      if (malformed > 0) out.errors.push(`${answersPath}: ${malformed} malformed rows skipped`);
      out.candidates = rows.map((row) => ({ row, cwd: null }));
      out.watermarks.set(answersPath, { offset: end, prefixHash: prefixHash(bytes.subarray(0, end)) });
      return out;
    },
  };
}
