import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { estimateTokens } from '@titan-design/retrieval';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { graphNoteRelevance } from '../bootstrap/rank-notes.js';
import { DF_CAP_FLOOR } from './derive-query.js';
import { searchWorkspace } from './index.js';
import { ownerShown, writeCharter } from '../test-support/visibility.js';
import { relatedContext, withinBudget, type RelatedInput } from './related.js';
import { openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { demoteToLegacy, refreshInto, removeFile, scaffold, writeFile } from '../test-support/workspace-index/fixture.js';

/**
 * `context related` over the miniature active root.
 *
 * What matters is the contract the two callers depend on: excluded refs never
 * come back, the budget bounds what is printed, and every failure yields an
 * empty list with a reason instead of an exception.
 */

let dir: string;
let root: string;
let dbPath: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-related-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  scaffold(root);
  writeCharter(root);
  (await refreshInto(dbPath, root)).db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const related = (input: Partial<RelatedInput> & { text: string }) =>
  relatedContext({ dbPath, activeRoot: root, ...input });

describe('relatedContext', () => {
  it('returns openable hits and the query that found them', async () => {
    const result = await related({ text: 'the alpha lesson', initiative: 'alpha' });

    expect(result.degraded).toEqual([]);
    expect(result.query.terms).toEqual(['alpha', 'lesson']);
    expect(result.hits[0]).toMatchObject({
      ref: 'note:alpha/2026-09-02-alpha-lesson.md',
      class: 'notes',
      initiative: 'alpha',
      title: 'The alpha lesson',
      path: 'alpha/sources/notes/2026-09-02-alpha-lesson.md',
    });
    expect(result.hits[0].excerpt).toBeTruthy();
  });

  it('never returns an excluded ref, and fills its place from further down', async () => {
    const top = await related({ text: 'indexer converges', limit: 6 });
    const [first, second] = top.hits.map((hit) => hit.ref);

    const result = await related({ text: 'indexer converges', limit: 3, exclude: [first] });

    expect(result.hits.map((hit) => hit.ref)).not.toContain(first);
    expect(result.hits[0].ref).toBe(second);
  });

  it('searches only the classes asked for', async () => {
    const result = await related({ text: 'indexer converges', classes: ['tasks'] });

    expect(result.hits.length).toBeGreaterThan(0);
    expect(new Set(result.hits.map((hit) => hit.class))).toEqual(new Set(['tasks']));
  });

  it('leaves transcripts out unless a caller names them', async () => {
    const result = await related({ text: 'indexer written' });

    expect(result.hits.every((hit) => hit.class !== 'transcripts')).toBe(true);
  });

  it('stops at the first hit that would overflow the budget', async () => {
    const result = await related({ text: 'lesson', render: () => 'x'.repeat(40), budget: 100 });

    expect(result.hits).toHaveLength(2);
  });

  it('handoff archives are not served by related but remain searchable', async () => {
    const archive = 'beta/sources/handoff-archive-2026-07.md';
    writeFile(root, archive, '# Handoff archive\n\nThe zeppelin rollout stalled twice.\n');
    const graph = await refreshInto(dbPath, root);
    const searched = await searchWorkspace('zeppelin', { graph, activeRoot: root, visible: await ownerShown(root) });
    graph.db.close();

    const result = await related({ text: 'zeppelin rollout', classes: ['sources'] });

    expect(searched.hits.map((hit) => hit.path)).toContain(archive);
    expect(result.hits.map((hit) => hit.path)).not.toContain(archive);
  });

  it.each([
    { scenario: 'declares none', frontmatter: '', expected: {} },
    {
      scenario: 'declares a read_if condition',
      frontmatter: 'read_if: changing the sample pipeline\n',
      expected: { readIf: 'changing the sample pipeline' },
    },
    {
      scenario: 'declares an invalid read_if',
      frontmatter: `read_if: ${'x'.repeat(161)}\n`,
      expected: {},
    },
  ])('a note hit whose file $scenario', async ({ frontmatter, expected }) => {
    writeFile(
      root,
      'alpha/sources/notes/2026-09-02-alpha-lesson.md',
      `---\nkind: process\ntitle: The alpha lesson\ncreated: 2026-09-02\n${frontmatter}---\n\nThe alpha lesson body.\n`,
    );

    const result = await related({ text: 'the alpha lesson', initiative: 'alpha' });

    const hit = result.hits.find((h) => h.ref === 'note:alpha/2026-09-02-alpha-lesson.md');
    expect(hit).toMatchObject(expected);
    expect('readIf' in hit!).toBe('readIf' in expected);
  });

  it('carries the winning span as a byte range into the file', async () => {
    const result = await related({ text: 'the alpha lesson', initiative: 'alpha' });
    const [top] = result.hits;
    const file = readFileSync(path.join(root, top.path!));

    expect(top.byteOffset).toBeGreaterThanOrEqual(0);
    expect(top.byteLength).toBeGreaterThan(0);
    expect(top.byteOffset! + top.byteLength!).toBeLessThanOrEqual(file.length);
  });

  it('degrades to no hits when the index is missing, without creating it', async () => {
    const missing = path.join(dir, 'absent.sqlite3');

    const result = await related({ text: 'lesson', dbPath: missing });

    expect(result.hits).toEqual([]);
    expect(result.degraded).toEqual([
      expect.objectContaining({ source: 'index', reason: 'missing' }),
    ]);
    expect(existsSync(missing)).toBe(false);
  });

  it('degrades to no hits when the index cannot be opened', async () => {
    const corrupt = path.join(dir, 'corrupt.sqlite3');
    writeFileSync(corrupt, 'not a database');

    const result = await related({ text: 'lesson', dbPath: corrupt });

    expect(result.hits).toEqual([]);
    expect(result.degraded[0]).toMatchObject({ source: 'index', reason: 'error' });
  });

  it('degrades to no hits when every retriever throws', async () => {
    const db = new Database(dbPath);
    db.exec('DROP TABLE search_fts');
    db.exec('DROP TABLE workspace_fts');
    db.close();

    const result = await related({ text: 'lesson' });

    expect(result.hits).toEqual([]);
    expect(result.degraded.length).toBeGreaterThan(0);
  });

  it('degrades to no hits on empty text and on text with no usable terms', async () => {
    for (const text of ['', '   ', 'it is the of']) {
      const result = await related({ text });
      expect(result.hits).toEqual([]);
      expect(result.degraded[0]).toMatchObject({ source: 'query', reason: 'empty' });
    }
  });
});

describe('the frequency cap across a cutover', () => {
  const TEXT = 'lesson quokka wombat numbat';
  const NOTE = 'note:alpha/2026-09-02-alpha-lesson.md';

  function withGraph(act: (graph: WorkspaceGraph) => void): void {
    const graph = openGraph(dbPath);
    try {
      act(graph);
    } finally {
      graph.db.close();
    }
  }

  /** Transcripts full of a word the fixture's note also uses, past the cap on a small graph. */
  function seedCommonTranscripts(graph: WorkspaceGraph): void {
    graph.db.transaction(() => {
      for (let i = 0; i <= DF_CAP_FLOOR; i++) {
        const span = { ownerRef: `session:s${i}`, field: 'text', sourceId: 1, byteOffset: i, byteLength: 1 };
        graph.spans.index(span, 'lesson filler');
      }
    })();
  }

  beforeEach(() => withGraph(seedCommonTranscripts));

  it('keeps a common word in a workspace query after the flip', async () => {
    const result = await related({ text: TEXT });

    expect(result.query.terms).toContain('lesson');
    expect(result.hits.map((hit) => hit.ref)).toContain(NOTE);
  });

  it('drops a common word from a query that includes transcripts', async () => {
    const result = await related({ text: TEXT, classes: ['notes', 'transcripts'] });

    expect(result.query.terms).not.toContain('lesson');
  });

  it('drops a common word from a workspace query before the flip', async () => {
    withGraph((graph) => demoteToLegacy(graph, root));

    const result = await related({ text: TEXT });

    expect(result.query.terms).not.toContain('lesson');
  });

  it('finds a note by a common word after the flip', () => {
    const hits = graphNoteRelevance(dbPath)(TEXT.split(' '));

    expect(hits.map((hit) => hit.ref)).toContain(NOTE);
  });

  it('does not find a note by a common word before the flip', () => {
    withGraph((graph) => demoteToLegacy(graph, root));

    expect(graphNoteRelevance(dbPath)(TEXT.split(' '))).toEqual([]);
  });
});

describe('withinBudget', () => {
  it('keeps rank order and cuts at the first overflow rather than skipping ahead', () => {
    const kept = withinBudget(['aaaa', 'bbbbbbbb', 'c'], 10, (hit) => hit);

    expect(kept).toEqual(['aaaa']);
  });
});

describe('relatedContext in context mode', () => {
  const refsOf = (items: { ref: string }[]) => items.map((item) => item.ref);

  function sessionRecord(n: number): string {
    return [
      '---',
      `session_id: keeper-log-${n}`,
      `started: 2026-09-1${n}T09:00:00Z`,
      `ended: 2026-09-1${n}T09:30:00Z`,
      'track: canonical',
      'next_steps: []',
      'resolves: []',
      '---',
      '',
      `The lighthouse keeper logged entry ${n} about the lighthouse lamp.`,
      '',
    ].join('\n');
  }

  it('no mode returns the list shape unchanged', async () => {
    const implicit = await related({ text: 'indexer converges' });
    const explicit = await related({ text: 'indexer converges', mode: 'list' });

    expect(JSON.stringify(implicit)).toBe(JSON.stringify(explicit));
    expect('entries' in implicit).toBe(false);
  });

  it('context mode spends at most the token budget', async () => {
    let chosen: Awaited<ReturnType<typeof related>> | undefined;
    let budget = 0;
    for (budget = 5; budget <= 400 && chosen === undefined; budget += 5) {
      const attempt = await related({
        text: 'indexer lesson beta alpha',
        mode: 'context',
        tokens: budget,
      });
      const overBudget = (attempt.dropped ?? []).some((drop) => drop.reason === 'over-budget');
      if ((attempt.entries ?? []).length > 0 && overBudget) chosen = attempt;
    }
    budget -= 5;

    expect(chosen).toBeDefined();
    const entries = chosen!.entries!;
    const sum = entries.reduce((total, entry) => total + entry.tokens, 0);
    expect(sum).toBeLessThanOrEqual(budget);
    expect(chosen!.usedTokens).toBe(sum);
    expect(chosen!.budgetTokens).toBe(budget);
    expect(entries.every((entry) => entry.tokens === estimateTokens(entry.text))).toBe(true);
    expect(refsOf(chosen!.hits)).toEqual(refsOf(entries));
  });

  it('class shares act as token quotas', async () => {
    for (const n of [1, 2, 3, 4]) {
      writeFile(
        root,
        `alpha/sessions/2026-09-1${n}-0900-lighthouse-keeper-log-entry-0${n}.md`,
        sessionRecord(n),
      );
    }
    writeFile(
      root,
      'alpha/sources/notes/2026-09-10-lighthouse.md',
      '---\nkind: process\ntitle: The lighthouse log\ncreated: 2026-09-10\n---\n\nThe lighthouse lamp burns oil.\n',
    );
    (await refreshInto(dbPath, root)).db.close();

    // Quotas bind at placement; deepening is capped per entry, not per class, so test tier 0.
    const result = await related({ text: 'lighthouse', mode: 'context', tokens: 100, maxTier: 0 });

    const sessionTokens = result
      .entries!.filter((entry) => entry.class === 'sessions')
      .reduce((total, entry) => total + entry.tokens, 0);
    expect(refsOf(result.entries!)).toContain('note:alpha/2026-09-10-lighthouse.md');
    expect(sessionTokens).toBeLessThanOrEqual(0.2 * 100);
    expect(result.dropped).toContainEqual(
      expect.objectContaining({ class: 'sessions', reason: 'over-quota' }),
    );
  });

  it('a hit whose file is missing stays at tier 1', async () => {
    removeFile(root, 'alpha/sources/notes/2026-09-02-alpha-lesson.md');

    const result = await related({
      text: 'the alpha lesson',
      initiative: 'alpha',
      mode: 'context',
      tokens: 2000,
    });

    const missing = result.entries!.find((e) => e.ref === 'note:alpha/2026-09-02-alpha-lesson.md');
    expect(result.degraded.filter((d) => d.source === 'search')).toEqual([]);
    expect(missing?.tier).toBe(1);
    expect(result.entries!.some((entry) => entry.tier === 2)).toBe(true);
  });

  it('context mode on a missing index still carries empty context fields', async () => {
    const result = await relatedContext({
      dbPath: path.join(dir, 'none.sqlite3'),
      activeRoot: root,
      text: 'lesson',
      mode: 'context',
      tokens: 50,
    });

    expect(result).toMatchObject({ entries: [], dropped: [], usedTokens: 0, budgetTokens: 50 });
    expect(result.degraded).toEqual([
      expect.objectContaining({ source: 'index', reason: 'missing' }),
    ]);
  });
});
