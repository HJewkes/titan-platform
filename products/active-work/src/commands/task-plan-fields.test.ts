import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import { asTask } from '../test-support/as-task.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';
import { planOutcomeAdd } from './plan-add.js';
import { planBetAdd } from './plan-bet.js';
import taskAdd from './task-add.js';
import taskEdit from './task-edit.js';

const SLUG = 'sample-initiative';

const ctx = (activeRoot: string): CommandContext => ({ activeRoot, warnings: [], format: 'json' });

/** Proposes `sample-initiative/B1` through the plan verbs, so the real bet lookup holds it. */
async function seedBet(root: string): Promise<void> {
  const outcome = { initiative: SLUG, slug: 'faster-landing', statement: 'Landing is quick', measure: 'p50 minutes' };
  await planOutcomeAdd.run(outcome, ctx(root));
  const prediction = { metric: 'p50 minutes', direction: 'decrease' as const, baseline: 40, expected: 25, read_by: '2026-11-30' };
  await planBetAdd.run({ initiative: SLUG, week: '2026-W47', outcome: `${SLUG}/faster-landing`, selector: 'tag:landing', ...prediction }, ctx(root));
}

describe('task plan fields through the plan store', () => {
  it('a task naming an existing bet passes and an unknown one is refused', async () => {
    await withTempActiveRoot(async (root) => {
      await seedBet(root);

      const known = asTask(await taskAdd.run({ slug: SLUG, title: 'Serve it', bet: `${SLUG}/B1` }, ctx(root)));
      const unknown = taskAdd.run({ slug: SLUG, title: 'Stray', bet: `${SLUG}/B9` }, ctx(root));

      expect(known.bet).toBe(`${SLUG}/B1`);
      await expect(unknown).rejects.toThrow(ValidationError);
      await expect(unknown).rejects.toThrow(`Unknown bet id: ${SLUG}/B9`);
    });
  });

  it('task add sets fold and owner steps, and task edit sets the bet and adds a step', async () => {
    await withTempActiveRoot(async (root) => {
      await seedBet(root);
      const add = { slug: SLUG, title: 'Ship it', fold: 'independent', owner_step: ['publish: first npm publish'] };

      const added = asTask(await taskAdd.run(add, ctx(root)));
      const edit = { slug: SLUG, id: added.id, bet: `${SLUG}/B1`, owner_step: ['restart:reload the daemon'] };
      const edited = asTask(await taskEdit.run(edit, ctx(root)));

      expect(added.fold).toBe('independent');
      expect(edited.bet).toBe(`${SLUG}/B1`);
      expect(edited.owner_steps).toEqual([
        { kind: 'publish', note: 'first npm publish' },
        { kind: 'restart', note: 'reload the daemon' },
      ]);
    });
  });

  it('refuses an owner step with an unknown kind or no note', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(taskAdd.run({ slug: SLUG, title: 'X', owner_step: ['dance:now'] }, ctx(root))).rejects.toThrow(ValidationError);
      await expect(taskAdd.run({ slug: SLUG, title: 'X', owner_step: ['release'] }, ctx(root))).rejects.toThrow(ValidationError);
    });
  });

  it('task edit refuses a bet the plan store does not hold', async () => {
    await withTempActiveRoot(async (root) => {
      const added = asTask(await taskAdd.run({ slug: SLUG, title: 'Ship it' }, ctx(root)));

      const edit = taskEdit.run({ slug: SLUG, id: added.id, bet: `${SLUG}/B1` }, ctx(root));

      await expect(edit).rejects.toThrow(`Unknown bet id: ${SLUG}/B1`);
    });
  });
});
