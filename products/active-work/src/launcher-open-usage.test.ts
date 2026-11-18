import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from './errors.js';
import { runOpen } from './launcher-open.js';
import { withTempActiveRoot } from './test-support/test-helpers.js';
import * as paths from './utils/paths.js';

const TIMING_KEYS = ['load', 'live_status', 'rank_notes', 'loop_retrieval', 'loop_queries', 'total'];

interface UsageLine {
  command?: string;
  duration_ms?: number;
  timings_ms?: Record<string, number>;
}

async function usageLines(stateDir: string): Promise<UsageLine[]> {
  const raw = await fs.readFile(path.join(stateDir, 'usage.jsonl'), 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line): UsageLine => JSON.parse(line))
    .filter((rec) => rec.command === 'aw.open');
}

describe('runOpen usage record', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-open-usage-'));
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(stateDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it('appends one aw.open line carrying every phase timing after a successful open', async () => {
    await withTempActiveRoot(async () => {
      await runOpen({ slug: 'sample-initiative' });

      const lines = await usageLines(stateDir);
      expect(lines).toHaveLength(1);
      const rec = lines.at(0);
      expect(rec).toMatchObject({
        command: 'aw.open',
        success: true,
        exit_code: 0,
        args: { slug: 'sample-initiative', resolved_from: 'slug' },
      });
      expect(rec?.duration_ms).toBeGreaterThanOrEqual(0);
      for (const key of TIMING_KEYS) expect(rec?.timings_ms?.[key]).toBeGreaterThanOrEqual(0);
    });
  });

  it('still returns the prompt when the state dir is unwritable', async () => {
    const sentinel = path.join(stateDir, 'sentinel');
    await fs.writeFile(sentinel, 'x');
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(path.join(sentinel, 'nested'));

    await withTempActiveRoot(async () => {
      const result = await runOpen({ slug: 'sample-initiative' });
      expect('prompt' in result && result.prompt.length > 0).toBe(true);
    });
  });

  it('writes no aw.open line when the slug matches nothing', async () => {
    await withTempActiveRoot(async () => {
      await expect(runOpen({ slug: 'no-such-initiative' })).rejects.toBeInstanceOf(NotFoundError);
      expect(await usageLines(stateDir)).toHaveLength(0);
    });
  });
});
