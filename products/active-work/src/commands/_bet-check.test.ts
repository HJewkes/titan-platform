import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import { assertKnownBet } from './_bet-check.js';

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
});
