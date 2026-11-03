import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import loopImport from '../../src/commands/loop-import.js';
import loopTier from '../../src/commands/loop-tier.js';
import { NotFoundError, UsageError, ValidationError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';
import { buildHttpApp } from '../../src/server/http.js';
import { SNAPSHOT, TIER_SEED, TREE } from '../fixtures/loop-ledger.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json', cwd: activeRoot };
}

function ledgerPath(root: string): string {
  return path.join(root, 'titan-platform', 'sources', 'open-loops.yml');
}

async function seedLedger(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'snapshot.yml'), SNAPSHOT);
  await fs.writeFile(path.join(root, 'tree.yml'), TREE);
  await fs.writeFile(path.join(root, 'tiers.json'), JSON.stringify(TIER_SEED));
  const args = { snapshot: 'snapshot.yml', tree: 'tree.yml', tiers: 'tiers.json' };
  await loopImport.run(loopImport.args.parse(args), makeCtx(root));
}

function tier(root: string, args: Record<string, unknown>) {
  return loopTier.run(loopTier.args.parse(args), makeCtx(root));
}

/** Each row's text, keyed by id: the slice from its `- id:` line to the next. */
function rowBlocks(text: string): Map<string, string> {
  const blocks = text.split(/^(?= {2}- id: )/m).slice(1);
  return new Map(blocks.map((block) => [/- id: (\S+)/.exec(block)![1]!, block]));
}

describe('loop tier', () => {
  it('moves one loop to A and leaves every other row byte-identical', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLedger(root);
      const before = await fs.readFile(ledgerPath(root), 'utf8');

      const result = await tier(root, { id: 'loop-b', tier: 'A' });

      const after = await fs.readFile(ledgerPath(root), 'utf8');
      expect(result).toMatchObject({ id: 'loop-b', tier: 'A', tier_rank: 2, tier_set: { by: 'owner' } });
      const [was, now] = [rowBlocks(before), rowBlocks(after)];
      expect(now.get('loop-a')).toBe(was.get('loop-a'));
      expect(now.get('loop-c')).toBe(was.get('loop-c'));
      expect(now.get('loop-b')).toMatch(/tier: A\n {4}tier_rank: 2\n {4}tier_set: \{at: .*, by: owner\}/);
      expect(after.split('\n')[0]).toBe('# Open loops sweep (synthetic). Schema: see the sweep notes.');
    });
  });

  it('places a loop ahead of the one named by --before without renumbering it', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLedger(root);

      const result = await tier(root, { id: 'loop-b', tier: 'A', before: 'loop-a' });

      expect(result.tier_rank).toBe(0);
      expect(await fs.readFile(ledgerPath(root), 'utf8')).toMatch(/id: loop-a[\s\S]*tier_rank: 1\n/);
    });
  });

  it('clears the tier for unsorted but records that the owner chose it', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLedger(root);

      const result = await tier(root, { id: 'loop-a', tier: 'unsorted' });

      expect(result).toMatchObject({ tier: null, tier_rank: null, tier_set: { by: 'owner' } });
      const block = rowBlocks(await fs.readFile(ledgerPath(root), 'utf8')).get('loop-a')!;
      expect(block).not.toMatch(/tier:|tier_rank:/);
      expect(block).toMatch(/tier_set: \{at: .*, by: owner\}/);
    });
  });

  it('refuses an unknown id, a --before outside the tier, and --before with unsorted', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLedger(root);

      await expect(tier(root, { id: 'loop-z', tier: 'A' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(tier(root, { id: 'loop-a', tier: 'S', before: 'loop-c' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        tier(root, { id: 'loop-a', tier: 'unsorted', before: 'loop-b' }),
      ).rejects.toBeInstanceOf(UsageError);
    });
  });

  it('refuses before any ledger is imported', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(tier(root, { id: 'loop-a', tier: 'A' })).rejects.toThrow(/run `active-work loop import` first/);
    });
  });
});

describe('loop board over the daemon', () => {
  it('serves the imported ledger and tree as rpc loop.board', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLedger(root);

      const res = await buildHttpApp({ port: 0 }).request('/rpc/loop.board', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-titan-client': 'test' },
        body: '{}',
      });

      const body = (await res.json()) as {
        ok: boolean;
        data: {
          ledger: { path: string };
          loops: Array<{ id: string; tier: string | null; source: string }>;
          tree: { nodes: unknown[] };
        };
      };
      expect(body.ok).toBe(true);
      expect(body.data.ledger.path).toBe(ledgerPath(root));
      const ledgerLoops = body.data.loops.filter((loop) => loop.source === 'ledger');
      expect(ledgerLoops.map((loop) => [loop.id, loop.tier])).toEqual([
        ['loop-a', 'A'],
        ['loop-b', 'S'],
        ['loop-c', 'parked'],
      ]);
      expect(body.data.tree.nodes).toHaveLength(2);
    });
  });
});
