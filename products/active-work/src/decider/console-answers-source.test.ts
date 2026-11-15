/**
 * The console's `answers.jsonl` as a precedent ledger source. Synthetic rows shaped like the
 * console's decision log stand in for real owner answers.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractPrecedents } from './extract.js';
import { readLedgerRows } from './ledger.js';
import { searchPrecedents } from './search.js';
import { openGraph } from '../session-index/graph.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';

const SOURCE = 'console-answers';

let dir: string;
let answersFile: string;
let graphPath: string;

function answerRow(id: string, question: string, answer: string, initiative = 'sample-initiative') {
  const at = `2026-10-01T10:00:0${id}.000Z`;
  return {
    v: 2,
    source: 'queue',
    key: `queue:item-${id}:${at}`,
    asked_at: null,
    answered_at: at,
    locator: { path: answersFile },
    initiative,
    category: 'policy',
    header: 'policy',
    question,
    options: [{ label: 'Ship it' }, { label: 'Hold' }],
    recommended: 'Ship it',
    answer,
    free_text: null,
    answered_by: 'owner-remote',
    route: null,
    item: { id: `item-${id}`, sources: [], kind: 'decide', door: 'two-way', keys: [] },
    by: { id: 'owner', channel: 'console' },
    decisions: 'a-b',
  };
}

const lineOf = (row: unknown): string => `${JSON.stringify(row)}\n`;

function writeCharter(activeRoot: string, humanOnly: string[]): void {
  const charterDir = path.join(activeRoot, 'claude-channels', 'sources', 'autonomy');
  mkdirSync(charterDir, { recursive: true });
  const frontmatter = `human_only_initiatives: ${JSON.stringify(humanOnly)}`;
  writeFileSync(path.join(charterDir, 'charter.md'), `---\n${frontmatter}\n---\nBody\n`, 'utf8');
}

async function extract(activeRoot: string, humanOnly: string[] = []) {
  writeCharter(activeRoot, humanOnly);
  const result = await extractPrecedents({
    activeRoot,
    graphPath,
    eventsDbPath: path.join(dir, 'events.db'),
    consoleAnswersPath: answersFile,
  });
  const summary = result.sources.find((s) => s.source === SOURCE);
  const rows = (await readLedgerRows(activeRoot)).rows.filter((r) => r.answered_by === 'owner-remote');
  return { summary, rows };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-console-answers-'));
  answersFile = path.join(dir, 'console-state', 'answers.jsonl');
  mkdirSync(path.dirname(answersFile), { recursive: true });
  graphPath = path.join(dir, 'graph.sqlite3');
  openGraph(graphPath).db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('console answers in precedent extract', () => {
  it('index each answer row so precedent search returns it', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeFileSync(
        answersFile,
        lineOf(answerRow('1', 'Rotate the staging signing key this week?', 'Ship it')) +
          lineOf(answerRow('2', 'Pin the lint plugin to the old major?', 'Hold')),
      );

      const { summary, rows } = await extract(activeRoot);

      expect(summary).toMatchObject({ read: 2, written: 2, errors: [] });
      expect(rows).toHaveLength(2);
      const hits = await searchPrecedents(rows, 'rotate the signing key', { isVisible: () => true });
      expect(hits[0]?.row.question).toBe('Rotate the staging signing key this week?');
    });
  });

  it('write nothing on a rerun with no new bytes', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeFileSync(answersFile, lineOf(answerRow('1', 'Rotate the staging signing key?', 'Ship it')));
      await extract(activeRoot);

      const { summary } = await extract(activeRoot);

      expect(summary).toMatchObject({ read: 0, written: 0, alreadyIndexed: 0 });
    });
  });

  it('pick up only the row appended since the last run', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeFileSync(answersFile, lineOf(answerRow('1', 'Rotate the staging signing key?', 'Ship it')));
      await extract(activeRoot);
      appendFileSync(answersFile, lineOf(answerRow('2', 'Pin the lint plugin?', 'Hold')));

      const { summary, rows } = await extract(activeRoot);

      expect(summary).toMatchObject({ read: 1, written: 1 });
      expect(rows.map((r) => r.question).sort()).toEqual([
        'Pin the lint plugin?',
        'Rotate the staging signing key?',
      ]);
    });
  });

  it('count a malformed line in errors and skip it', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeFileSync(
        answersFile,
        `{not json\n${lineOf({ v: 2, source: 'queue' })}${lineOf(answerRow('1', 'Rotate the key?', 'Ship it'))}`,
      );

      const { summary, rows } = await extract(activeRoot);

      expect(summary?.written).toBe(1);
      expect(summary?.errors).toEqual([`${answersFile}: 2 malformed rows skipped`]);
      expect(rows).toHaveLength(1);
    });
  });

  it('give no rows and no error when the file is missing', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const { summary, rows } = await extract(activeRoot);

      expect(summary).toMatchObject({ read: 0, written: 0, errors: [] });
      expect(rows).toEqual([]);
    });
  });

  it('drop a row whose initiative is withheld from agents', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeFileSync(answersFile, lineOf(answerRow('1', 'Rotate the staging signing key?', 'Ship it')));

      const { summary, rows } = await extract(activeRoot, ['sample-initiative']);

      expect(summary?.excluded['human-only-initiative']).toBe(1);
      expect(rows).toEqual([]);
    });
  });
});
