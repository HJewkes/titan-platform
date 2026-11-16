import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleBootstrap, type LiveStatusFetcher } from './prompt.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';

const SLUG = 'sample-initiative';
const STARTUP_WAIT_MS = 2000;

async function seedBranch(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, SLUG, 'artifacts.yml'),
    'branches:\n  - repo: ~/code/sample\n    name: feat/sample\nstashes: []\nworktrees: []\n',
    'utf8',
  );
}

describe('bootstrap live status and archive overlap', () => {
  it('starts the live branch lookup before a pending archive pass completes', async () => {
    await withTempActiveRoot(async (root) => {
      await seedBranch(root);
      let markLiveStarted: () => void = () => {};
      const liveStarted = new Promise<void>((resolve) => {
        markLiveStarted = resolve;
      });
      const fetcher: LiveStatusFetcher = async () => {
        markLiveStarted();
        return [];
      };
      const blockedArchive = (async () => {
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('archive finished before live status started')), STARTUP_WAIT_MS);
        });
        await Promise.race([liveStarted, timeout]);
        return { archivedIds: ['ZZ-99'], tasks: [], malformed: [] };
      })();

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: SLUG,
        detectSiblings: false,
        hitLog: async () => null,
        liveStatusFetcher: fetcher,
        pendingArchive: blockedArchive,
      });

      expect(prompt).toContain('ZZ-99');
    });
  });
});
