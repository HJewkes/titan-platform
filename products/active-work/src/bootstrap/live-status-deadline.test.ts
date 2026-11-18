import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Artifacts } from '../schemas/artifacts.js';
import { renderArtifactsBody } from './render-artifacts.js';
import type { LiveBranchStatus } from './prompt.js';

const SLUG = 'sample-initiative';

function artifactsWith(branchCount: number, stashCount = 0): Artifacts {
  return {
    branches: Array.from({ length: branchCount }, (_, i) => ({
      repo: '~/code/sample',
      name: `feat/b${i}`,
    })),
    stashes: Array.from({ length: stashCount }, (_, i) => ({
      repo: '~/code/sample',
      label: `stash-${i}`,
    })),
    worktrees: [],
  };
}

const liveStatus: LiveBranchStatus = {
  repo: '~/code/sample',
  name: 'feat/b0',
  present: true,
  last_commit_iso: '2026-07-21T09:14:00Z',
  ahead: 1,
  behind: 2,
  pr: null,
};

describe('live status deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders static branches and a timeout line when the fetcher never settles', async () => {
    const pending = renderArtifactsBody({
      artifacts: artifactsWith(2),
      slug: SLUG,
      includeLiveStatus: true,
      fetcher: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(2500);
    const body = await pending;
    expect(body).toContain('Branches:\n- feat/b0 (~/code/sample)');
    expect(body).not.toContain('(live)');
    expect(body).toContain('Live branch status timed out after 2500 ms');
  });

  it('renders live lines when the fetcher resolves before the deadline', async () => {
    const pending = renderArtifactsBody({
      artifacts: artifactsWith(1),
      slug: SLUG,
      includeLiveStatus: true,
      fetcher: async () => [liveStatus],
    });
    await vi.advanceTimersByTimeAsync(10);
    const body = await pending;
    expect(body).toContain('Branches (live):');
    expect(body).not.toContain('timed out');
  });

  it('caps 15 static branches at 10 with an overflow line', async () => {
    const body = await renderArtifactsBody({
      artifacts: artifactsWith(15),
      slug: SLUG,
      includeLiveStatus: false,
      fetcher: async () => [],
    });
    expect(body).toContain('feat/b9');
    expect(body).not.toContain('feat/b10 ');
    expect(body).toContain(`(+5 more — \`active-work artifact list ${SLUG}\`)`);
  });

  it('caps 15 stashes at 10 with an overflow line', async () => {
    const body = await renderArtifactsBody({
      artifacts: artifactsWith(0, 15),
      slug: SLUG,
      includeLiveStatus: false,
      fetcher: async () => [],
    });
    expect(body).toContain('stash-9');
    expect(body).not.toContain('stash-10');
    expect(body).toContain(`(+5 more — \`active-work artifact list ${SLUG}\`)`);
  });
});
