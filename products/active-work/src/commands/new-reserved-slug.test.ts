import { describe, expect, it } from 'vitest';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import newCommand from './new.js';

/** The miner keys sessions by these names, so an initiative so named would pass as one (TP-5750). */
describe('new', () => {
  it.each(['unknown', 'other', 'owner-only'])('refuses the reserved miner key %s as a slug', async (slug) => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await expect(newCommand.run({ slug, title: 'Reserved' }, { activeRoot, warnings: [], format: 'json', caller: 'owner' })).rejects.toThrow(
        /reserved as a miner report key/,
      );
    });
  });
});
