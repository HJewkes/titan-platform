import { existsSync } from 'node:fs';
import type { LedgerRow } from '@titan-design/decider';
import type { DerivedQuery } from '@titan-design/retrieval';
import { ledgerPath, readLedgerRows } from '../decider/ledger.js';
import { searchPrecedents } from '../decider/search.js';
import type { Shown } from '../sessions/visibility.js';
import { DECISIONS_CLASS } from './classes.js';
import type { RelatedDegradation, RelatedHit } from './related.js';

/**
 * Owner decisions for related context: the precedent ledger ranked with the
 * same retriever `precedent search` uses, one hit per row.
 */

interface DecisionOptions {
  query: DerivedQuery;
  visible: Shown;
  activeRoot: string;
  limit: number;
  initiative?: string;
  exclude?: string[];
}

function decisionHit(row: LedgerRow): RelatedHit {
  const answered = row.answer === null ? row.question : `${row.question} -> ${row.answer}`;
  return {
    ref: `decision:${row.key}`,
    class: DECISIONS_CLASS.name,
    initiative: row.initiative,
    title: row.header ?? row.question,
    path: null,
    excerpt: answered,
    byteOffset: null,
    byteLength: null,
  };
}

function degraded(reason: string, message: string): RelatedDegradation {
  return { source: DECISIONS_CLASS.name, reason, message };
}

/** A fresh workspace has no ledger yet, which is worth saying but not worth failing over. */
export async function decisionHits(
  options: DecisionOptions,
): Promise<{ hits: RelatedHit[]; degraded: RelatedDegradation[] }> {
  const { query, visible, activeRoot, limit, initiative } = options;
  const exclude = new Set(options.exclude ?? []);
  try {
    const { rows } = await readLedgerRows(activeRoot);
    if (rows.length === 0 && !existsSync(ledgerPath(activeRoot))) {
      return { hits: [], degraded: [degraded('missing', 'no decision ledger')] };
    }
    const ranked = await searchPrecedents(rows, query.terms.join(' '), {
      isVisible: visible,
      limit: limit + exclude.size,
      ...(initiative !== undefined ? { initiative } : {}),
    });
    const hits = ranked.map(({ row }) => decisionHit(row)).filter((hit) => !exclude.has(hit.ref));
    return { hits: hits.slice(0, limit), degraded: [] };
  } catch (err) {
    return { hits: [], degraded: [degraded('error', err instanceof Error ? err.message : String(err))] };
  }
}
