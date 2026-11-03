import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import loopImport from '../../src/commands/loop-import.js';
import loopTier from '../../src/commands/loop-tier.js';
import type { CommandContext } from '../../src/registry/index.js';
import { SNAPSHOT, TIER_SEED, TREE } from '../fixtures/loop-ledger.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

interface Row {
  id: string;
  title: string;
  tier?: string;
  tier_rank?: number;
  tier_set?: { at: string; by: string };
}

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json', cwd: activeRoot };
}

async function writeInputs(root: string, snapshot = SNAPSHOT): Promise<void> {
  await fs.writeFile(path.join(root, 'snapshot.yml'), snapshot);
  await fs.writeFile(path.join(root, 'tree.yml'), TREE);
  await fs.writeFile(path.join(root, 'tiers.json'), JSON.stringify(TIER_SEED));
}

async function runImport(root: string, args: Record<string, unknown>) {
  const ctx = makeCtx(root);
  const result = await loopImport.run(loopImport.args.parse({ snapshot: 'snapshot.yml', ...args }), ctx);
  return { result, warnings: ctx.warnings };
}

async function ledgerText(root: string): Promise<string> {
  return fs.readFile(path.join(root, 'titan-platform', 'sources', 'open-loops.yml'), 'utf8');
}

async function ledgerRows(root: string): Promise<Map<string, Row>> {
  const rows = (YAML.parse(await ledgerText(root)) as { loops: Row[] }).loops;
  return new Map(rows.map((row) => [row.id, row]));
}

describe('loop import', () => {
  it('creates the ledger and tree from a snapshot and seeds the proposed tiers', async () => {
    await withTempActiveRoot(async (root) => {
      await writeInputs(root);

      const { result } = await runImport(root, { tree: 'tree.yml', tiers: 'tiers.json' });

      expect(result).toMatchObject({ added: 3, updated: 0, seeded: 3 });
      const rows = await ledgerRows(root);
      expect(rows.get('loop-b')).toMatchObject({ tier: 'S', tier_rank: 1, tier_set: { by: 'proposal' } });
      expect(rows.get('loop-a')).toMatchObject({ tier: 'A', tier_rank: 1 });
      expect(rows.get('loop-c')).toMatchObject({ tier: 'parked' });
      expect(await ledgerText(root)).toMatch(/^# Open loops sweep \(synthetic\)/);
      const tree = await fs.readFile(path.join(root, 'titan-platform', 'sources', 'tech-tree.yml'), 'utf8');
      expect(tree).toBe(TREE);
    });
  });

  it('writes an untiered first import as the snapshot text, comments and layout intact', async () => {
    await withTempActiveRoot(async (root) => {
      await writeInputs(root);

      await runImport(root, {});

      expect(await ledgerText(root)).toBe(SNAPSHOT);
    });
  });

  it('leaves ids the seed does not name unsorted', async () => {
    await withTempActiveRoot(async (root) => {
      await writeInputs(root);
      await fs.writeFile(path.join(root, 'tiers.json'), JSON.stringify({ A: ['loop-a', 'loop-z'] }));

      const { warnings } = await runImport(root, { tiers: 'tiers.json' });

      const rows = await ledgerRows(root);
      expect(rows.get('loop-b')?.tier).toBeUndefined();
      expect(warnings).toEqual(['Tier seed names loop-z, which is not in the ledger']);
    });
  });

  it('keeps a tier the owner set when a newer sweep imports the same loop', async () => {
    await withTempActiveRoot(async (root) => {
      await writeInputs(root);
      await runImport(root, { tiers: 'tiers.json' });
      await loopTier.run(loopTier.args.parse({ id: 'loop-a', tier: 'C' }), makeCtx(root));
      const resweep = SNAPSHOT.replace('"Synthetic loop A"', '"Synthetic loop A, renamed"').replace(
        '    tech_tree_node: N1\n',
        '    tech_tree_node: N1\n    tier: S\n',
      );
      await writeInputs(root, resweep);

      const { result } = await runImport(root, { tiers: 'tiers.json' });

      expect(result).toMatchObject({ added: 0, updated: 3, seeded: 0 });
      const row = (await ledgerRows(root)).get('loop-a');
      expect(row).toMatchObject({ title: 'Synthetic loop A, renamed', tier: 'C', tier_set: { by: 'owner' } });
    });
  });

  it('adds a loop a later sweep finds and keeps rows it no longer lists', async () => {
    await withTempActiveRoot(async (root) => {
      await writeInputs(root);
      await runImport(root, {});
      const later = `loops:\n  - id: loop-d\n    title: "Synthetic loop D"\n    initiative: sample-initiative\n    status: MISSING\n`;
      await writeInputs(root, later);

      const { result } = await runImport(root, {});

      expect(result).toMatchObject({ added: 1, updated: 0 });
      expect([...(await ledgerRows(root)).keys()]).toEqual(['loop-a', 'loop-b', 'loop-c', 'loop-d']);
    });
  });

  it('refuses a snapshot with no loops list and writes nothing', async () => {
    await withTempActiveRoot(async (root) => {
      await writeInputs(root, 'nodes: []\n');

      await expect(runImport(root, {})).rejects.toThrow(/the snapshot has no `loops:` list/);
      await expect(ledgerText(root)).rejects.toThrow(/ENOENT/);
    });
  });
});
