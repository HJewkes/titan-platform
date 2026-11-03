import { afterEach, describe, expect, it, vi } from 'vitest';

import { assembleBootstrap } from '../../src/bootstrap/prompt.js';
import openCommand, { formatTimings } from '../../src/commands/open.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const NOW = new Date('2026-05-12T16:00:00Z');
const PHASES = ['load', 'live_status', 'rank_notes', 'loop_retrieval'] as const;

const withoutClock = (prompt: string) => prompt.replace(/^- Bootstrap: .*$/m, '- Bootstrap: <now>');

function steppingClock(): () => number {
  let tick = 0;
  return () => (tick += 7);
}

const assemble = (root: string, clock?: () => number) =>
  assembleBootstrap({
    activeRoot: root,
    slug: SLUG,
    now: NOW,
    detectSiblings: false,
    includeLiveStatus: false,
    noteRelevance: async () => new Map(),
    loopRetriever: async () => ({ hits: [], degraded: [], query: { terms: [], expression: '' } }),
    hitLog: async () => null,
    ...(clock ? { clock } : {}),
  });

describe('bootstrap timings_ms', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('carries every phase key as a non-negative number and a loop query count', async () => {
    await withTempActiveRoot(async (root) => {
      const { metadata } = await assemble(root);

      const timings = metadata.timings_ms!;
      for (const phase of PHASES) expect(timings[phase]).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(timings.loop_queries)).toBe(true);
    });
  });

  it('leaves the prompt bytes identical whichever clock is injected', async () => {
    await withTempActiveRoot(async (root) => {
      const real = await assemble(root);
      const fake = await assemble(root, steppingClock());

      expect(withoutClock(fake.prompt)).toBe(withoutClock(real.prompt));
      expect(fake.prompt).not.toMatch(/timing|_ms/);
    });
  });

  it('reads durations off the injected clock', async () => {
    await withTempActiveRoot(async (root) => {
      const { metadata } = await assemble(root, steppingClock());

      expect(metadata.timings_ms!.load).toBe(7);
      expect(metadata.timings_ms!.rank_notes).toBe(7);
    });
  });
});

describe('open timings_ms', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('adds archive and total to the result metadata and keeps them out of the prompt', async () => {
    await withTempActiveRoot(async (root) => {
      const args = openCommand.args.parse({ slug: SLUG, offline: true });
      const result = (await openCommand.run(args, {
        activeRoot: root,
        warnings: [],
        format: 'json',
      })) as { prompt: string; metadata: { timings_ms: Record<string, number> } };

      const timings = result.metadata.timings_ms;
      for (const key of ['load', 'archive', 'live_status', 'rank_notes', 'loop_retrieval', 'total']) {
        expect(timings[key]).toBeGreaterThanOrEqual(0);
      }
      expect(result.prompt).not.toContain('total=');
    });
  });

  it('prints one stderr line only when AW_TIMING is 1', async () => {
    await withTempActiveRoot(async (root) => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const run = () =>
        openCommand.run(openCommand.args.parse({ slug: SLUG, offline: true }), {
          activeRoot: root,
          warnings: [],
          format: 'json',
        });

      await run();
      expect(write).not.toHaveBeenCalled();

      vi.stubEnv('AW_TIMING', '1');
      await run();
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]![0])).toMatch(/^aw timing sample-initiative: load=\d+ms .* total=\d+ms\n$/);
    });
  });

  it('formats the line with the query count', () => {
    const line = formatTimings('x', {
      load: 1,
      archive: 2,
      live_status: 3,
      rank_notes: 4,
      loop_retrieval: 5,
      loop_queries: 6,
      total: 7,
    });

    expect(line).toBe(
      'aw timing x: load=1ms archive=2ms live_status=3ms rank_notes=4ms loop_retrieval=5ms (6 queries) total=7ms\n',
    );
  });
});
