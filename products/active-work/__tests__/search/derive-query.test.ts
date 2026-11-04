import { describe, expect, it } from 'vitest';

import {
  DF_CAP_FLOOR,
  deriveQuery,
  documentFrequencyCap,
  selectTerms,
  type DocumentFrequency,
} from '../../src/search/derive-query.js';

const frequencies =
  (counts: Record<string, number>): DocumentFrequency =>
  (term) =>
    counts[term] ?? 0;

describe('deriveQuery', () => {
  it('picks the rarest terms rather than the first ones', () => {
    const df = frequencies({ common: 900, usual: 500, rare: 3, rarer: 1 });

    const query = deriveQuery('common usual rare rarer', df, { limit: 2 });

    expect(query.terms).toEqual(['rarer', 'rare']);
  });

  it('breaks rarity ties by first appearance, so the same text derives the same query', () => {
    expect(deriveQuery('zeta alpha mid', frequencies({ mid: 5 }), { limit: 2 }).terms).toEqual([
      'zeta',
      'alpha',
    ]);
  });

  it('never lets a commit hash win on rarity', () => {
    const query = deriveQuery('merged 9f3c2ab1 and deadbeef00 into main', frequencies({}), { limit: 2 });

    expect(query.terms).toEqual(['merged', 'main']);
  });

  it('keeps a short hex-looking word, which is not a hash', () => {
    expect(deriveQuery('cafe decade', frequencies({}), { limit: 5 }).terms).toEqual(['cafe', 'decade']);
  });

  it('appends every task id even when rarity already filled the limit', () => {
    const query = deriveQuery('TP-84 scored recall; see AW-138 and ranker', frequencies({}), { limit: 1 });

    expect(query.terms).toEqual(['scored', 'tp-84', 'aw-138']);
  });

  it('quotes terms into an OR expression FTS5 can parse', () => {
    expect(deriveQuery('TP-84 harness', frequencies({}), { limit: 5 }).expression).toBe(
      '"harness" OR "tp-84"',
    );
  });

  it('derives nothing from text that is all stop words and short tokens', () => {
    expect(deriveQuery('it is on the of a b', frequencies({}))).toEqual({
      terms: [],
      expression: '',
    });
  });

  it('drops a term matching more spans than the cap', () => {
    const df = frequencies({ agent: 500_000, retrieval: 900, ranker: 40, harness: 12 });

    const query = deriveQuery('agent retrieval ranker harness', df, { maxDf: 20_000 });

    expect(query.terms).toEqual(['harness', 'ranker', 'retrieval']);
  });

  it('keeps a task id even when the cap drops every word around it', () => {
    const df = frequencies({ agent: 500_000, now: 250_000, next: 140_000, its: 330_000 });

    const query = deriveQuery('TP-84 agent now next its', df, { maxDf: 20_000 });

    expect(query.terms).toEqual(['next', 'now', 'its', 'tp-84']);
  });
});

describe('selectTerms', () => {
  it('keeps the three rarest when fewer than three clear the cap', () => {
    const df = frequencies({ agent: 500_000, now: 250_000, next: 140_000, rare: 7 });

    expect(selectTerms(['agent', 'now', 'next', 'rare'], df, { maxDf: 20_000 })).toEqual([
      'rare',
      'next',
      'now',
    ]);
  });

  it('applies the limit after the cap', () => {
    const df = frequencies({ a1: 1, a2: 2, a3: 3, a4: 4, big: 1e6 });

    expect(selectTerms(['big', 'a4', 'a3', 'a2', 'a1'], df, { maxDf: 10, limit: 3 })).toEqual([
      'a1',
      'a2',
      'a3',
    ]);
  });

  it('keeps every term of a query shorter than the fallback', () => {
    const df = frequencies({ agent: 500_000, now: 250_000 });

    expect(selectTerms(['agent', 'now'], df, { maxDf: 20_000 })).toEqual(['now', 'agent']);
  });
});

describe('documentFrequencyCap', () => {
  it('is one percent of a large corpus', () => {
    expect(documentFrequencyCap(2_355_782)).toBe(23_557);
  });

  it('never drops below the floor on a small graph', () => {
    expect(documentFrequencyCap(5_000)).toBe(DF_CAP_FLOOR);
  });
});
