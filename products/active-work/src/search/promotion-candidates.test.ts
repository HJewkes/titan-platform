import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promotionCandidates } from './promotion-candidates.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promotion-candidates-'));
  file = path.join(dir, 'retrieval-hits.jsonl');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const line = (ref: string, slug: string, ts: string): string =>
  JSON.stringify({ ts, slug, ref, trigger: 'spawn', query: 'q', rank: 1 });

describe('promotionCandidates', () => {
  it('lists a note surfaced in 3 renders across 2 initiatives and skips one under the threshold', async () => {
    await fs.writeFile(
      file,
      [
        line('note:over', 'alpha', '2026-11-01T00:00:00Z'),
        line('note:over', 'alpha', '2026-11-02T00:00:00Z'),
        line('note:over', 'beta', '2026-11-03T00:00:00Z'),
        line('note:under', 'alpha', '2026-11-01T00:00:00Z'),
        line('note:under', 'beta', '2026-11-02T00:00:00Z'),
        line('note:single', 'alpha', '2026-11-01T00:00:00Z'),
        line('note:single', 'alpha', '2026-11-02T00:00:00Z'),
        line('note:single', 'alpha', '2026-11-03T00:00:00Z'),
      ]
        .map((l) => l + '\n')
        .join(''),
    );

    expect(await promotionCandidates(file)).toEqual([{ ref: 'note:over', renders: 3, initiatives: 2 }]);
  });

  it('counts one render for the several hits a single session render logged', async () => {
    await fs.writeFile(
      file,
      [
        line('note:dup', 'alpha', '2026-11-01T00:00:00Z'),
        line('note:dup', 'alpha', '2026-11-01T00:00:00Z'),
        line('note:dup', 'beta', '2026-11-02T00:00:00Z'),
      ]
        .map((l) => l + '\n')
        .join(''),
    );

    expect(await promotionCandidates(file)).toEqual([]);
  });

  it('ignores refs that are not notes', async () => {
    await fs.writeFile(
      file,
      ['a', 'a', 'b'].map((slug, i) => line('task:T-1', slug, `2026-11-0${i + 1}T00:00:00Z`) + '\n').join(''),
    );

    expect(await promotionCandidates(file)).toEqual([]);
  });

  it('sorts by render count, then ref', async () => {
    const rows = [
      ['note:b', 'alpha', '1'],
      ['note:b', 'beta', '2'],
      ['note:b', 'beta', '3'],
      ['note:a', 'alpha', '1'],
      ['note:a', 'beta', '2'],
      ['note:a', 'beta', '3'],
      ['note:c', 'alpha', '1'],
      ['note:c', 'beta', '2'],
      ['note:c', 'beta', '3'],
      ['note:c', 'beta', '4'],
    ].map(([ref, slug, n]) => line(ref, slug, `2026-11-0${n}T00:00:00Z`) + '\n');
    await fs.writeFile(file, rows.join(''));

    const refs = (await promotionCandidates(file)).map((c) => c.ref);

    expect(refs).toEqual(['note:c', 'note:a', 'note:b']);
  });

  it('skips a corrupt line and still reads the rest', async () => {
    await fs.writeFile(
      file,
      [
        line('note:ok', 'alpha', '2026-11-01T00:00:00Z'),
        '{not json',
        '{"ref":5}',
        line('note:ok', 'beta', '2026-11-02T00:00:00Z'),
        line('note:ok', 'beta', '2026-11-03T00:00:00Z'),
      ]
        .map((l) => l + '\n')
        .join(''),
    );

    expect(await promotionCandidates(file)).toEqual([{ ref: 'note:ok', renders: 3, initiatives: 2 }]);
  });

  it('returns nothing when the log is absent', async () => {
    expect(await promotionCandidates(path.join(dir, 'missing.jsonl'))).toEqual([]);
  });
});
