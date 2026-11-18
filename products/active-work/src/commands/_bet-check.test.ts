import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import { withTempActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';
import { assertKnownBet } from './_bet-check.js';
import { planBetAdd } from './plan-bet.js';
import { planOutcomeAdd } from './plan-add.js';

const ctx = (activeRoot: string): CommandContext => ({ activeRoot, warnings: [], format: 'json' });

const betArgs = {
  initiative: 'alpha',
  week: '2026-W47',
  outcome: 'alpha/faster-landing',
  task: ['alpha/AL-1'],
  metric: 'p50 minutes',
  direction: 'decrease' as const,
  baseline: 40,
  expected: 25,
  read_by: '2026-11-30',
};

async function seedAlphaWithTwoBets(root: string): Promise<void> {
  writeAgentVisibleBrief(root, 'alpha');
  await planOutcomeAdd.run(
    { initiative: 'alpha', slug: 'faster-landing', statement: 'Landing is quick', measure: 'p50 minutes' },
    ctx(root),
  );
  await planBetAdd.run(betArgs, ctx(root));
  await planBetAdd.run(betArgs, ctx(root));
}

describe('assertKnownBet', () => {
  it('a task naming an unknown bet id fails validation at write', async () => {
    await expect(assertKnownBet({ bet: 'alpha/B9' }, { has: async () => false })).rejects.toThrow(
      ValidationError,
    );
  });

  it('accepts a task with no bet, and a bet the lookup knows', async () => {
    await expect(assertKnownBet({})).resolves.toBeUndefined();
    await expect(assertKnownBet({ bet: 'alpha/B1' }, { has: async () => true })).resolves.toBeUndefined();
  });

  it('an unknown bet names the initiative bets and the add command', async () => {
    await withTempActiveRoot(async (root) => {
      await seedAlphaWithTwoBets(root);

      await expect(assertKnownBet({ bet: 'alpha/B9' }, undefined, 'alpha')).rejects.toThrow(
        'Unknown bet id: alpha/B9. alpha has bets: alpha/B1, alpha/B2; list them with active-work plan bet list --initiative alpha --state proposed, or propose one with active-work plan bet add alpha',
      );
    });
  });

  it('an unknown bet in an initiative with no bets says so and gives the add hint', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'beta');

      await expect(assertKnownBet({ bet: 'beta/B1' }, undefined, 'beta')).rejects.toThrow(
        'Unknown bet id: beta/B1. beta has no bets yet; propose one with active-work plan bet add beta',
      );
    });
  });

  it('a bet the store holds still passes with the initiative given', async () => {
    await withTempActiveRoot(async (root) => {
      await seedAlphaWithTwoBets(root);

      await expect(assertKnownBet({ bet: 'alpha/B1' }, undefined, 'alpha')).resolves.toBeUndefined();
    });
  });
});
