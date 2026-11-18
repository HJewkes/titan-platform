import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { lintIntent } from './intent.js';

let initiativeDir: string;

/** A copy of the record without one key, the way a hand-edited file would drop it. */
function withoutKey<T extends object>(record: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

const good = { id: 'alpha/I1', section: 'Taste', date: '2026-11-01', quote: 'Invented quote', ref: 'msg:abc1' };

async function writeLine(name: string, record: object): Promise<void> {
  const dir = path.join(initiativeDir, 'plan', 'intent');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), YAML.stringify(record));
}

beforeEach(() => {
  initiativeDir = mkdtempSync(path.join(tmpdir(), 'aw-lint-intent-'));
});

afterEach(() => {
  rmSync(initiativeDir, { recursive: true, force: true });
});

describe('lintIntent', () => {
  it('passes a dated, quoted line', async () => {
    await writeLine('I1.yml', good);

    await expect(lintIntent('alpha', initiativeDir)).resolves.toEqual([]);
  });

  it('refuses a line without a quote and a line without a date, naming each file', async () => {
    const noQuote = withoutKey(good, 'quote');
    const noDate = withoutKey(good, 'date');
    await writeLine('I2.yml', { ...noQuote, id: 'alpha/I2' });
    await writeLine('I3.yml', { ...noDate, id: 'alpha/I3' });

    const findings = await lintIntent('alpha', initiativeDir);

    expect(findings).toEqual([
      expect.objectContaining({ level: 'error', file: 'plan/intent/I2.yml', message: expect.stringContaining('quote') }),
      expect.objectContaining({ level: 'error', file: 'plan/intent/I3.yml', message: expect.stringContaining('date') }),
    ]);
  });

  it('reports a file that is not YAML instead of throwing', async () => {
    await fs.mkdir(path.join(initiativeDir, 'plan', 'intent'), { recursive: true });
    await fs.writeFile(path.join(initiativeDir, 'plan', 'intent', 'I4.yml'), 'key: [unclosed');

    const findings = await lintIntent('alpha', initiativeDir);

    expect(findings).toEqual([expect.objectContaining({ level: 'error', file: 'plan/intent/I4.yml' })]);
  });
});
