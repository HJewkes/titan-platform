import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getStateRoot } from '../utils/paths.js';

/**
 * Every retrieved hit a session was shown, one JSON line each.
 *
 * "Shown to a session" is the signal note promotion (TP-27 Half B) was waiting
 * for. It lives in the state dir rather than the graph because the index is
 * derived and disposable, and a rebuild must not erase the history of what
 * was surfaced.
 */

export const HIT_TRIGGERS = ['bootstrap-loop', 'bootstrap-foreign', 'spawn'] as const;

const MAX_LOGGED_QUERY = 500;

type HitTrigger = (typeof HIT_TRIGGERS)[number];

export interface HitLogEntry {
  ts: string;
  slug: string;
  trigger: HitTrigger;
  /** The text the hit was retrieved for, capped at MAX_LOGGED_QUERY characters. */
  query: string;
  /** First 16 hex characters of the sha256 of the full, uncapped query. */
  queryHash?: string;
  ref: string;
  /** The search class the hit came from. */
  class?: string;
  /** Context mode only: the tier the hit was served at. */
  tier?: number;
  /** 1-based, within the list the hit was rendered in. */
  rank: number;
  /** The winning span's byte range in the hit's file; null when the hit carries no span. */
  byteOffset: number | null;
  byteLength: number | null;
}

/** Resolves to an error message when the append failed, null when it did not. */
export type HitLogWriter = (entries: HitLogEntry[]) => Promise<string | null>;

function hitLogPath(): string {
  return path.join(getStateRoot(), 'retrieval-hits.jsonl');
}

/** Best effort: a failed append is returned for the caller to report, never thrown. */
export function fileHitLog(file: string = hitLogPath()): HitLogWriter {
  return async (entries) => {
    if (entries.length === 0) return null;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, entries.map((entry) => JSON.stringify(entry) + '\n').join(''));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
}

interface ServedHit {
  ref: string;
  class?: string;
  tier?: number;
  byteOffset: number | null;
  byteLength: number | null;
}

interface ServedContext {
  ts: string;
  slug: string;
  trigger: HitTrigger;
  query: string;
}

/** One entry per served hit, ranked in the order served. */
export function servedHitEntries(hits: ServedHit[], context: ServedContext): HitLogEntry[] {
  const query = context.query.slice(0, MAX_LOGGED_QUERY);
  const queryHash = createHash('sha256').update(context.query).digest('hex').slice(0, 16);
  return hits.map((hit, i) => ({
    ...context,
    query,
    queryHash,
    ...(hit.class !== undefined ? { class: hit.class } : {}),
    ...(hit.tier !== undefined ? { tier: hit.tier } : {}),
    ref: hit.ref,
    rank: i + 1,
    byteOffset: hit.byteOffset,
    byteLength: hit.byteLength,
  }));
}
