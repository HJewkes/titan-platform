import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import { withTempActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';
import { planOutcomeAdd } from './plan-add.js';
import { planSeed } from './plan-seed.js';

const ctx = (activeRoot: string): CommandContext => ({ activeRoot, warnings: [], format: 'json' });

const digestText = [
  '---',
  'schema: titan-intent-digest/v1',
  'slug: alpha',
  'initiative: alpha',
  'built_from: synthetic fixture',
  '---',
  '## Standing direction',
  '- I1 2026-11-01 "Keep landing fast" (quote: msg:aaa111)',
  '- I2 2026-11-02 "Old direction" (quote: msg:bbb222) superseded-by: I3',
  '- I3 2026-11-03 "New direction" (quote: msg:ccc333)',
  '## Reasons',
  '- I4 2026-11-04 "Because the queue is slow" (quote: msg:ddd444)',
  '## Ruled out',
  '- I5 2026-11-05 "No rewrite of the lander" (quote: msg:eee555)',
  '## Taste',
  '- I6 2026-11-06 "Small diffs" (quote: msg:fff666)',
  '## Open questions',
  '- I7 2026-11-07 "Who owns retries?" (quote: msg:abc777)',
  '## Superseded',
  '',
].join('\n');

interface TaskSeed {
  id: string;
  priority: number;
  status?: string;
  done_when?: string | undefined;
  tags?: string[];
}

async function writeTask(root: string, seed: TaskSeed): Promise<void> {
  const dir = path.join(root, 'alpha', 'tasks');
  await fs.mkdir(dir, { recursive: true });
  const task = {
    id: seed.id,
    title: `Task ${seed.id}`,
    priority: seed.priority,
    status: seed.status ?? 'open',
    done_when: seed.done_when,
    tags: seed.tags ?? ['web'],
    created: '2026-11-01',
    updated: '2026-11-01',
    done_at: null,
  };
  await fs.writeFile(path.join(dir, `${seed.id}.yml`), YAML.stringify(task));
}

async function writeDigest(root: string, text: string): Promise<string> {
  const file = path.join(root, 'digest.md');
  await fs.writeFile(file, text);
  return file;
}

async function seed(root: string, text = digestText) {
  writeAgentVisibleBrief(root, 'alpha');
  const digest = await writeDigest(root, text);
  return { initiative: 'alpha', domain: 'web', digest };
}

describe('plan.seed', () => {
  it('drops a superseded line and keeps its replacement with date and quote ref', async () => {
    await withTempActiveRoot(async (root) => {
      const result = await planSeed.run(await seed(root), ctx(root));

      const direction = result.intent.standing_direction.map((line) => line.id);
      expect(direction).toEqual(['alpha/I1', 'alpha/I3']);
      expect(result.markdown).toContain('2026-11-03 "New direction" (quote: msg:ccc333)');
      expect(result.markdown).not.toContain('Old direction');
    });
  });

  it('includes the ruled-out lines', async () => {
    await withTempActiveRoot(async (root) => {
      const result = await planSeed.run(await seed(root), ctx(root));

      expect(result.intent.ruled_out.map((line) => line.quote)).toEqual(['No rewrite of the lander']);
      expect(result.markdown).toContain('## Ruled out');
      expect(result.markdown).toContain('No rewrite of the lander');
    });
  });

  it('lists only open, done_when-bearing, domain-tagged tasks in priority order', async () => {
    await withTempActiveRoot(async (root) => {
      const args = await seed(root);
      await writeTask(root, { id: 'AL-1', priority: 30, done_when: 'third' });
      await writeTask(root, { id: 'AL-2', priority: 10, done_when: 'first' });
      await writeTask(root, { id: 'AL-3', priority: 5, status: 'done', done_when: 'finished' });
      await writeTask(root, { id: 'AL-4', priority: 6 });
      await writeTask(root, { id: 'AL-5', priority: 7, done_when: 'other domain', tags: ['api'] });

      const result = await planSeed.run(args, ctx(root));

      expect(result.tasks.map((task) => task.id)).toEqual(['AL-2', 'AL-1']);
    });
  });

  it('returns the parser line-numbered errors for a malformed digest', async () => {
    await withTempActiveRoot(async (root) => {
      const args = await seed(root, digestText.replace('"Keep landing fast"', 'Keep landing fast'));

      const failure = planSeed.run(args, ctx(root));

      await expect(failure).rejects.toBeInstanceOf(ValidationError);
      await expect(failure).rejects.toThrow(/line 8: bullet has no quote in double quotes/);
    });
  });

  it('yields an empty outcomes section for an initiative with no outcomes', async () => {
    await withTempActiveRoot(async (root) => {
      const result = await planSeed.run(await seed(root), ctx(root));

      expect(result.outcomes).toEqual([]);
      expect(result.markdown).toContain('## Success statements');
    });
  });

  it('lists the initiative outcome statements', async () => {
    await withTempActiveRoot(async (root) => {
      const args = await seed(root);
      await planOutcomeAdd.run(
        { initiative: 'alpha', slug: 'faster-landing', statement: 'Landing is quick', measure: 'p50 minutes' },
        ctx(root),
      );

      const result = await planSeed.run(args, ctx(root));

      expect(result.outcomes.map((outcome) => outcome.statement)).toEqual(['Landing is quick']);
      expect(result.markdown).toContain('Landing is quick');
    });
  });
});
