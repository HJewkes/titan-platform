import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseClustererSnapshot } from '@titan-design/cluster';

import { loadTreeSnapshots, saveTreeSnapshots } from './tree-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-tree-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tree store', () => {
  it('keeps an unknown partition key through save then load', async () => {
    const snapshot = parseClustererSnapshot({
      version: 1,
      partitions: [
        {
          partition: 'tool-a',
          nextClusterId: 2,
          clusters: [{ clusterId: 1, tokens: ['x', '<*>'], size: 3 }],
          templateIds: [[1, 'tpl-1']],
          futureField: { note: 'kept' },
        },
      ],
    });

    await saveTreeSnapshots(snapshot, dir);

    expect(await loadTreeSnapshots(dir)).toEqual(snapshot);
  });

  it('returns an empty snapshot when nothing was saved', async () => {
    expect(await loadTreeSnapshots(dir)).toEqual({ version: 1, partitions: [] });
  });
});
