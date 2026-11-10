import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import minerCost from './miner-cost.js';
import { UsageError } from '../errors.js';
import type { CommandContext } from '../registry/types.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';

const ctx: CommandContext = { activeRoot: '', warnings: [], format: 'json' };

describe('miner cost --session-ids', () => {
  it('miner cost refuses a --session-ids file with no ids as a usage error', async () => {
    await withEmptyActiveRoot(async (root) => {
      const idsFile = path.join(root, 'empty-ids.txt');
      writeFileSync(idsFile, '\n  \n', 'utf8');

      const run = minerCost.run({ session_ids: [`@${idsFile}`] }, ctx);

      await expect(run).rejects.toBeInstanceOf(UsageError);
      await expect(run).rejects.toThrow(idsFile);
    });
  });
});
