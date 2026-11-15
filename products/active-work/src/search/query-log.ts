import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getStateRoot } from '../utils/paths.js';

/**
 * One JSON line per search run, so a query that found nothing is countable.
 * `recovered` is reserved for the later recovery step; the search itself never sets it.
 */
interface SearchQueryRecord {
  ts: string;
  query: string;
  hits: number;
  degraded: number;
  callerKind: 'owner' | 'agent' | 'unknown';
  recovered?: boolean;
}

/** Best effort: telemetry must never fail the search it describes. */
export async function appendSearchQuery(record: SearchQueryRecord): Promise<void> {
  try {
    const file = path.join(getStateRoot(), 'search-queries.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // Intentionally silent.
  }
}
