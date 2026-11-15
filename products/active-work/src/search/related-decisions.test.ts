import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { relatedContext, type RelatedInput } from './related.js';
import { refreshInto, scaffold } from '../test-support/workspace-index/fixture.js';
import { writeCharter } from '../test-support/visibility.js';

/** The decisions class of `context related`, over the miniature active root. */

const OPEN_KEY = 'transcript:sess-open:tu-open';
const HIDDEN_KEY = 'transcript:sess-hidden:tu-hidden';

let dir: string;
let root: string;
let dbPath: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-related-decisions-'));
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

function v1Row(key: string, initiative: string, question: string) {
  return {
    key,
    source: 'transcript',
    asked_at: '2026-08-01T09:00:00Z',
    session_id: 'sess',
    tool_use_id: key,
    initiative,
    class: 'release_publish',
    header: 'Lesson scope',
    question,
    options: ['Keep it (Recommended)', 'Drop it'],
    recommended: 'Keep it (Recommended)',
    answer: 'Drop it',
    pick_type: 'other_option',
    free_text: null,
  };
}

function seedLedger(initiative: string, rows: ReturnType<typeof v1Row>[]): void {
  const file = path.join(root, initiative, 'sources', 'precedents.jsonl');
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

describe('relatedContext decisions class', () => {
  it('returns a ledger row beside a note hit', async () => {
    seedLedger('alpha', [v1Row(OPEN_KEY, 'alpha', 'Should the alpha lesson stay?')]);

    const result = await related({ text: 'the alpha lesson', initiative: 'alpha' });

    expect(result.hits.map((hit) => hit.class)).toEqual(expect.arrayContaining(['notes', 'decisions']));
    expect(result.hits.find((hit) => hit.class === 'decisions')).toMatchObject({
      ref: `decision:${OPEN_KEY}`,
      title: 'Lesson scope',
      excerpt: 'Should the alpha lesson stay? -> Drop it',
      initiative: 'alpha',
    });
  });

  it('withholds a row from an owner-only initiative', async () => {
    writeCharter(root, ['beta']);
    seedLedger('beta', [v1Row(HIDDEN_KEY, 'beta', 'Should the alpha lesson stay?')]);
    seedLedger('alpha', [v1Row(OPEN_KEY, 'alpha', 'Unrelated question about gardens?')]);

    const result = await related({ text: 'the alpha lesson', initiative: 'alpha' });

    expect(result.hits.map((hit) => hit.ref)).not.toContain(`decision:${HIDDEN_KEY}`);
  });

  it('reports a missing ledger as degraded while other classes still return', async () => {
    const result = await related({ text: 'the alpha lesson', initiative: 'alpha' });

    expect(result.degraded).toEqual([expect.objectContaining({ source: 'decisions', reason: 'missing' })]);
    expect(result.hits.some((hit) => hit.class === 'notes')).toBe(true);
  });

  it('leaves decisions out when only notes are asked for', async () => {
    seedLedger('alpha', [v1Row(OPEN_KEY, 'alpha', 'Should the alpha lesson stay?')]);

    const result = await related({ text: 'the alpha lesson', initiative: 'alpha', classes: ['notes'] });

    expect(result.hits.every((hit) => hit.class === 'notes')).toBe(true);
    expect(result.degraded).toEqual([]);
  });

  it('never returns an excluded decision', async () => {
    seedLedger('alpha', [v1Row(OPEN_KEY, 'alpha', 'Should the alpha lesson stay?')]);

    const result = await related({
      text: 'the alpha lesson',
      initiative: 'alpha',
      exclude: [`decision:${OPEN_KEY}`],
    });

    expect(result.hits.map((hit) => hit.ref)).not.toContain(`decision:${OPEN_KEY}`);
  });

  it('drops a handoff archive from related while keeping decisions', async () => {
    seedLedger('alpha', [v1Row(OPEN_KEY, 'alpha', 'Should the zeppelin rollout stay?')]);
    writeFileSync(
      path.join(root, 'beta', 'sources', 'handoff-archive-2026-07.md'),
      '# Handoff archive\n\nThe zeppelin rollout stalled twice.\n',
      'utf8',
    );
    (await refreshInto(dbPath, root)).db.close();

    const result = await related({ text: 'zeppelin rollout' });

    expect(result.hits.map((hit) => hit.ref)).toEqual([`decision:${OPEN_KEY}`]);
  });
});
