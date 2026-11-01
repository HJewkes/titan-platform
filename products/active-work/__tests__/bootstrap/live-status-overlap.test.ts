import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LoopRetriever } from '../../src/bootstrap/loop-context.js';
import {
  assembleBootstrap,
  type BootstrapInput,
  type LiveStatusFetcher,
} from '../../src/bootstrap/prompt.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const NOW = new Date('2026-05-12T16:00:00Z');
const FETCH_MS = 150;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const withoutClock = (prompt: string) => prompt.replace(/^- Bootstrap: .*$/m, '- Bootstrap: <now>');

async function seed(root: string): Promise<void> {
  await fs.writeFile(
    path.join(root, SLUG, 'sessions', '2026-05-11-0900-loop-session.md'),
    [
      '---',
      'session_id: loop-session',
      'started: 2026-05-11T09:00:00Z',
      'ended: 2026-05-11T16:00:00Z',
      'track: canonical',
      'next_steps:',
      '  - id: s1',
      '    text: "Decide the eval harness"',
      '    kind: prose',
      '---',
      '',
      '- Loop session\n',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, SLUG, 'artifacts.yml'),
    ['branches:', '  - repo: ~/code/sample', '    name: feat/sample', 'stashes: []', 'worktrees: []', ''].join('\n'),
    'utf8',
  );
}

const run = (root: string, extra: Partial<BootstrapInput>) =>
  assembleBootstrap({
    activeRoot: root,
    slug: SLUG,
    now: NOW,
    detectSiblings: false,
    hitLog: async () => null,
    ...extra,
  });

const status = {
  repo: '~/code/sample',
  name: 'feat/sample',
  present: true,
  last_commit_iso: '2026-07-21T09:14:00Z',
  ahead: 1,
  behind: 0,
  pr: null,
};

describe('bootstrap live status overlap', () => {
  it('starts the live fetch before loop retrieval and renders the same prompt as the sequential order', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root);
      let fetchSettled = false;
      let retrieverSawFetchPending: boolean | undefined;
      const fetcher: LiveStatusFetcher = async () => {
        await wait(FETCH_MS);
        fetchSettled = true;
        return [status as never];
      };
      const retriever: LoopRetriever = async () => {
        retrieverSawFetchPending ??= !fetchSettled;
        await wait(FETCH_MS / 2);
        return { hits: [], degraded: [], query: { terms: [], expression: '' } };
      };

      const overlapped = await run(root, { liveStatusFetcher: fetcher, loopRetriever: retriever });
      const sequential = await run(root, {
        liveStatusFetcher: async () => [status as never],
        loopRetriever: retriever,
      });

      expect(retrieverSawFetchPending).toBe(true);
      expect(withoutClock(overlapped.prompt)).toBe(withoutClock(sequential.prompt));
      expect(overlapped.prompt).toContain('feat/sample');
    });
  });

  it('degrades to static artifacts, with no unhandled rejection, when the fetch rejects during ranking', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const fetcher: LiveStatusFetcher = () => Promise.reject(new Error('gh down'));
        const retriever: LoopRetriever = async () => {
          await wait(50);
          return { hits: [], degraded: [], query: { terms: [], expression: '' } };
        };

        const live = await run(root, { liveStatusFetcher: fetcher, loopRetriever: retriever });
        const offline = await run(root, { includeLiveStatus: false, loopRetriever: retriever });

        expect(withoutClock(live.prompt)).toBe(withoutClock(offline.prompt));
        await wait(10);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });
});
