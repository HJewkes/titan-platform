import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import precedentShow from './precedent-show.js';
import { NotFoundError } from '../errors.js';
import { withTempActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';

const OPEN_KEY = 'transcript:sess-open:tu-open';
const HIDDEN_KEY = 'transcript:sess-hidden:tu-hidden';
const LOOSE_KEY = 'transcript:sess-loose:tu-loose';

function v1Row(key: string, initiative: string | null, question: string) {
  const [, session, toolUse] = key.split(':');
  return {
    key,
    source: 'transcript',
    asked_at: '2026-08-01T09:00:00Z',
    session_id: session,
    tool_use_id: toolUse,
    initiative,
    class: 'release_publish',
    header: 'Release',
    question,
    options: ['Cut now (Recommended)', 'Wait a week'],
    recommended: 'Cut now (Recommended)',
    answer: 'Wait a week',
    pick_type: 'other_option',
    free_text: null,
  };
}

function writeRows(file: string, rows: unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function seed(activeRoot: string): void {
  writeAgentVisibleBrief(activeRoot, 'open-initiative');
  writeAgentVisibleBrief(activeRoot, 'hidden-initiative');
  writeFileSync(path.join(activeRoot, 'hidden-initiative', 'brief.md'), '---\nvisibility: owner-only\n---\n');
  writeRows(path.join(activeRoot, 'open-initiative', 'sources', 'precedents.jsonl'), [
    v1Row(OPEN_KEY, 'open-initiative', 'Cut the release now?'),
  ]);
  writeRows(path.join(activeRoot, 'hidden-initiative', 'sources', 'precedents.jsonl'), [
    v1Row(HIDDEN_KEY, 'hidden-initiative', 'Rotate the secret?'),
  ]);
  writeRows(path.join(activeRoot, '.precedents.jsonl'), [v1Row(LOOSE_KEY, null, 'Restart the broker?')]);
}

function ctxFor(activeRoot: string, caller: 'owner' | 'agent') {
  return { activeRoot, warnings: [] as string[], format: 'json' as const, caller };
}

describe('precedent show', () => {
  it('returns a claimed row in full with the search citation form', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      seed(activeRoot);

      const row = await precedentShow.run({ key: OPEN_KEY }, ctxFor(activeRoot, 'agent'));

      expect(row).toMatchObject({
        key: OPEN_KEY,
        source: 'transcript',
        asked_at: '2026-08-01T09:00:00Z',
        initiative: 'open-initiative',
        category: 'release_publish',
        header: 'Release',
        question: 'Cut the release now?',
        options: ['Cut now (Recommended)', 'Wait a week'],
        recommended: 'Cut now',
        answer: 'Wait a week',
        citation: 'session sess-open tool_use tu-open at 2026-08-01T09:00:00Z',
      });
      expect(row).toHaveProperty('outcome');
    });
  });

  it('is not found for an unknown key', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      seed(activeRoot);

      await expect(precedentShow.run({ key: 'transcript:none:none' }, ctxFor(activeRoot, 'owner'))).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  it('is not found for an agent asking for an owner-only initiative row, with the unknown-key message', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      seed(activeRoot);
      const unknownKey = 'transcript:none:none';
      const refusal = async (key: string): Promise<string> =>
        precedentShow.run({ key }, ctxFor(activeRoot, 'agent')).then(
          () => 'served',
          (error: unknown) => (error instanceof NotFoundError ? error.message.replace(key, '<key>') : 'wrong error'),
        );

      expect(await refusal(HIDDEN_KEY)).toBe(await refusal(unknownKey));
      expect(await refusal(HIDDEN_KEY)).toContain('<key>');
    });
  });

  it('returns an unclaimed row to the owner and not found to an agent', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      seed(activeRoot);

      const forOwner = await precedentShow.run({ key: LOOSE_KEY }, ctxFor(activeRoot, 'owner'));
      const forAgent = precedentShow.run({ key: LOOSE_KEY }, ctxFor(activeRoot, 'agent'));

      expect(forOwner.key).toBe(LOOSE_KEY);
      await expect(forAgent).rejects.toThrow(NotFoundError);
    });
  });
});
