import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import { assertKnownBet, noPlanStore } from './_bet-check.js';

describe('assertKnownBet', () => {
  it('a task naming an unknown bet id fails validation at write', async () => {
    await expect(assertKnownBet({ bet: 'alpha/B9' }, { has: async () => false })).rejects.toThrow(
      ValidationError,
    );
  });

  it('fails closed for a named bet while there is no plan store', async () => {
    await expect(assertKnownBet({ bet: 'alpha/B1' })).rejects.toThrow('Unknown bet id: alpha/B1');
    expect(await noPlanStore.has('alpha/B1')).toBe(false);
  });

  it('accepts a task with no bet, and a bet the lookup knows', async () => {
    await expect(assertKnownBet({})).resolves.toBeUndefined();
    await expect(assertKnownBet({ bet: 'alpha/B1' }, { has: async () => true })).resolves.toBeUndefined();
  });
});
