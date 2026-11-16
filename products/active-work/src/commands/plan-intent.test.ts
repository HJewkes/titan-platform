import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseIntentDigest } from '@titan-design/pm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import { withTempActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';
import { legacyOwnerMessagesPath, ownerMessagesPath } from '../plan/owner-messages.js';
import { planIntentAdd, planIntentDigest, planIntentImportMessages } from './plan-intent.js';
import { planIntentList, planIntentShow } from './plan-read.js';

const ctx = (activeRoot: string): CommandContext => ({ activeRoot, warnings: [], format: 'json' });

// Synthetic rows in the extractor's shape; no real owner message appears here.
const queueMessage = { id: '0a0a0a0a0a0a0a01', ts: '2026-11-02T09:00:00Z', text: 'Invented: keep the queue short.\nMore words.' };
const diffsMessage = { id: '0a0a0a0a0a0a0a02', ts: '2026-11-03', text: 'Invented: small diffs please' };
const messages = [queueMessage, diffsMessage];

async function writeJsonl(file: string, rows: readonly object[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

async function readIds(file: string): Promise<unknown[]> {
  const raw = await fs.readFile(file, 'utf8');
  return raw.trim().split('\n').map((row): unknown => z.object({ id: z.string() }).parse(JSON.parse(row)).id);
}

describe('plan intent verbs', () => {
  it('add writes the next intent line that show and list read back', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');
      const args = { initiative: 'alpha', section: 'Taste', quote: 'Invented taste', date: '2026-11-01', ref: 'msg:abc1' };

      const added = await planIntentAdd.run(args, ctx(root));
      const next = await planIntentAdd.run({ ...args, section: 'Reasons' }, ctx(root));
      const shown = await planIntentShow.run({ id: 'alpha/I2' }, ctx(root));
      const listed = await planIntentList.run({ initiative: 'alpha' }, ctx(root));

      expect(added).toEqual({ id: 'alpha/I1', section: 'Taste', date: '2026-11-01', quote: 'Invented taste', ref: 'msg:abc1' });
      expect(next.id).toBe('alpha/I2');
      expect(shown).toEqual(next);
      expect(listed).toEqual([added, next]);
      await expect(fs.access(path.join(root, 'alpha/plan/intent/I1.yml'))).resolves.toBeUndefined();
    });
  });

  it('add refuses a line without a quote or a date, writing nothing', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');

      const noQuote = planIntentAdd.run({ initiative: 'alpha', section: 'Taste', date: '2026-11-01', ref: 'msg:a' }, ctx(root));
      const noDate = planIntentAdd.run({ initiative: 'alpha', section: 'Taste', quote: 'Invented', ref: 'msg:a' }, ctx(root));

      await expect(noQuote).rejects.toThrow(/quote/);
      await expect(noDate).rejects.toThrow(/date/);
      await expect(planIntentList.run({ initiative: 'alpha' }, ctx(root))).resolves.toEqual([]);
    });
  });

  it('add --message takes the date and message id from the extract and refuses a quote the message lacks', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');
      await writeJsonl(ownerMessagesPath(root), messages);
      const base = { initiative: 'alpha', section: 'Standing direction', message: queueMessage.id };

      const line = await planIntentAdd.run({ ...base, quote: 'keep the queue short' }, ctx(root));
      const foreign = planIntentAdd.run({ ...base, quote: 'words never said' }, ctx(root));

      expect(line).toMatchObject({ date: '2026-11-02', quote: 'keep the queue short', ref: `msg:${queueMessage.id}` });
      await expect(foreign).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('digest renders a titan-intent-digest whose lines cite their message ids', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');
      await writeJsonl(ownerMessagesPath(root), messages);
      await planIntentAdd.run({ initiative: 'alpha', section: 'Taste', message: diffsMessage.id }, ctx(root));
      const out = path.join(root, 'alpha', 'plan', 'intent-digest.md');

      const digest = await planIntentDigest.run({ initiative: 'alpha', out }, ctx(root));
      const parsed = parseIntentDigest(await fs.readFile(out, 'utf8'));

      expect(digest.markdown).toContain(`- I1 2026-11-03 "Invented: small diffs please" (quote: msg:${diffsMessage.id})`);
      expect(parsed).toMatchObject({ ok: true, lines: [{ id: 'alpha/I1', ref: `msg:${diffsMessage.id}` }] });
    });
  });
});

describe('owner-message extract', () => {
  it('import writes the extract to factory/plan/owner-messages.jsonl, skipping ids already there', async () => {
    await withTempActiveRoot(async (root) => {
      await writeJsonl(legacyOwnerMessagesPath(root), messages);
      await writeJsonl(ownerMessagesPath(root), [queueMessage]);

      const result = await planIntentImportMessages.run({}, ctx(root));

      expect(ownerMessagesPath(root)).toBe(path.join(root, 'factory', 'plan', 'owner-messages.jsonl'));
      expect(result).toEqual({ path: ownerMessagesPath(root), added: 1, total: 2 });
      expect(await readIds(ownerMessagesPath(root))).toEqual(messages.map((m) => m.id));
    });
  });

  it('add --message falls back to the old sources/owner-intent extract when the new file is absent', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');
      await writeJsonl(legacyOwnerMessagesPath(root), messages);

      const line = await planIntentAdd.run({ initiative: 'alpha', section: 'Taste', message: diffsMessage.id }, ctx(root));

      expect(line.ref).toBe(`msg:${diffsMessage.id}`);
    });
  });
});
