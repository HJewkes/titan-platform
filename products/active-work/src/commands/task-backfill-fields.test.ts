import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../registry/index.js';
import { TaskSchema } from '../schemas/task.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import taskBackfill from './task-backfill-fields.js';

const SLUG = 'sample-initiative';
const HEURISTICS = { class: 'census-2026-11-12:theme+upkeep_label', source: 'census-2026-11-12:source' };

const ctx = (root: string): CommandContext => ({ activeRoot: root, warnings: [], format: 'json' });

const taskFile = (root: string, slug: string, id: string): string => path.join(root, slug, 'tasks', `${id}.yml`);

const readTask = (root: string, slug: string, id: string) => readYaml(taskFile(root, slug, id), TaskSchema);

function writeLabels(root: string, rows: object[]): string {
  const file = path.join(root, 'labels.jsonl');
  writeFileSync(file, rows.map((row) => JSON.stringify({ heuristics: HEURISTICS, ...row })).join('\n') + '\n');
  return file;
}

async function addOwnerOnlyInitiative(root: string): Promise<void> {
  const dir = path.join(root, 'private-one');
  mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  writeFileSync(path.join(dir, 'brief.md'), '---\nvisibility: owner-only\n---\n');
  const base = await readTask(root, SLUG, 'SI-1');
  await writeYaml(taskFile(root, 'private-one', 'PO-1'), { ...base, id: 'PO-1' }, TaskSchema);
}

const run = async (root: string, from: string, mode: 'dry_run' | 'apply') => {
  const result = await taskBackfill.run({ from, [mode]: true }, ctx(root));
  if (typeof result === 'string') throw new Error('expected a summary');
  return result;
};

describe('task backfill-fields', () => {
  it('backfill never overwrites a recorded field', async () => {
    await withTempActiveRoot(async (root) => {
      const file = taskFile(root, SLUG, 'SI-1');
      await writeYaml(file, { ...(await readTask(root, SLUG, 'SI-1')), class: 'product', field_origin: { class: 'filed' } }, TaskSchema);
      const labels = writeLabels(root, [{ task: `${SLUG}/SI-1`, class: 'upkeep', source: 'sweep' }]);

      await run(root, labels, 'apply');

      const task = await readTask(root, SLUG, 'SI-1');
      expect(task.class).toBe('product');
      expect(task.field_origin?.class).toBe('filed');
      expect(task.source).toBe('sweep');
      expect(task.field_origin?.source).toBe('inferred:census-2026-11-12-source');
    });
  });

  it('apply is idempotent', async () => {
    await withTempActiveRoot(async (root) => {
      const labels = writeLabels(root, [{ task: `${SLUG}/SI-1`, class: 'upkeep', serves: 'none', source: 'sweep' }]);
      await run(root, labels, 'apply');
      const afterFirst = readFileSync(taskFile(root, SLUG, 'SI-1'), 'utf8');

      const second = await run(root, labels, 'apply');

      expect(second.tasks_changed).toBe(0);
      expect(readFileSync(taskFile(root, SLUG, 'SI-1'), 'utf8')).toBe(afterFirst);
    });
  });

  it('a value outside an enum is skipped and counted', async () => {
    await withTempActiveRoot(async (root) => {
      const labels = writeLabels(root, [{ task: `${SLUG}/SI-1`, class: 'upkeep', source: 'unknown' }]);

      const summary = await run(root, labels, 'apply');

      const task = await readTask(root, SLUG, 'SI-1');
      expect(task.class).toBe('upkeep');
      expect(task.source).toBeUndefined();
      expect(summary.values_skipped).toEqual({ source: 1 });
    });
  });

  it('an owner-only initiative is skipped even when a row names it', async () => {
    await withTempActiveRoot(async (root) => {
      await addOwnerOnlyInitiative(root);
      const labels = writeLabels(root, [{ task: 'private-one/PO-1', class: 'upkeep' }]);

      const summary = await run(root, labels, 'apply');

      expect((await readTask(root, 'private-one', 'PO-1')).class).toBeUndefined();
      expect(summary.owner_only_skipped).toBe(1);
      expect(summary.tasks_changed).toBe(0);
    });
  });

  it('a row for a task with no file is counted, not created', async () => {
    await withTempActiveRoot(async (root) => {
      const labels = writeLabels(root, [{ task: `${SLUG}/SI-99`, class: 'upkeep' }]);

      const summary = await run(root, labels, 'apply');

      expect(summary.missing_tasks).toBe(1);
      expect(() => readFileSync(taskFile(root, SLUG, 'SI-99'))).toThrow();
    });
  });

  it('dry-run writes nothing and samples at most 10 task ids', async () => {
    await withTempActiveRoot(async (root) => {
      const base = await readTask(root, SLUG, 'SI-1');
      const ids = Array.from({ length: 12 }, (_, i) => `SI-${i + 10}`);
      for (const id of ids) await writeYaml(taskFile(root, SLUG, id), { ...base, id }, TaskSchema);
      const labels = writeLabels(root, ids.map((id) => ({ task: `${SLUG}/${id}`, class: 'upkeep' })));
      const before = readFileSync(taskFile(root, SLUG, 'SI-10'), 'utf8');

      const summary = await run(root, labels, 'dry_run');

      expect(readFileSync(taskFile(root, SLUG, 'SI-10'), 'utf8')).toBe(before);
      expect(summary.tasks_changed).toBe(12);
      expect(summary.fields_written).toEqual({ class: 12 });
      expect(summary.sample).toHaveLength(10);
    });
  });

  it('refuses a run that names neither or both modes', async () => {
    await withTempActiveRoot(async (root) => {
      const labels = writeLabels(root, []);

      await expect(taskBackfill.run({ from: labels }, ctx(root))).rejects.toThrow('exactly one');
      await expect(taskBackfill.run({ from: labels, dry_run: true, apply: true }, ctx(root))).rejects.toThrow('exactly one');
    });
  });
});
