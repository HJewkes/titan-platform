import { UsageError } from '../errors.js';

interface PageRequest {
  limit?: number;
  cursor?: string;
}

interface Page<T> {
  items: T[];
  total: number;
  truncated: boolean;
  // Null on the last page.
  next_cursor: string | null;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, total: number): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const offset = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset > total) {
    throw new UsageError(`Invalid cursor: ${cursor}`);
  }
  return offset;
}

/** Slices an already-ordered list; with no limit the rest of the list is returned. */
export function pageList<T>(ordered: readonly T[], request: PageRequest): Page<T> {
  const total = ordered.length;
  const start = request.cursor === undefined ? 0 : decodeCursor(request.cursor, total);
  const end = request.limit === undefined ? total : Math.min(start + request.limit, total);
  const truncated = end < total;
  return {
    items: ordered.slice(start, end),
    total,
    truncated,
    next_cursor: truncated ? encodeCursor(end) : null,
  };
}
