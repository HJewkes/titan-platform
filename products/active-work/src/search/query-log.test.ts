import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import searchCommand from '../commands/search.js';
import type { CommandContext } from '../registry/types.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import * as paths from '../utils/paths.js';

const LOG = 'search-queries.jsonl';

function context(activeRoot: string, caller?: 'owner' | 'agent'): CommandContext {
  return { activeRoot, warnings: [], format: 'json', caller };
}

const LineSchema = z.object({
  ts: z.string(),
  query: z.string(),
  hits: z.number(),
  degraded: z.number(),
  callerKind: z.string(),
});

function readLine(dir: string): z.infer<typeof LineSchema> {
  const first = readFileSync(path.join(dir, LOG), 'utf8').trim().split('\n')[0];
  return LineSchema.parse(JSON.parse(first));
}

describe('search query log', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'aw-query-log-'));
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(stateDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('writes hits 0 for a query nothing matches', async () => {
    await withEmptyActiveRoot(async (root) => {
      const result = await searchCommand.run({ query: 'zzzunmatchable' }, context(root, 'agent'));

      expect(result.hits).toHaveLength(0);
      expect(readLine(stateDir)).toMatchObject({
        query: 'zzzunmatchable',
        hits: 0,
        degraded: result.degraded.length,
        callerKind: 'agent',
      });
    });
  });

  it('writes the hit count for a query that matches', async () => {
    await withEmptyActiveRoot(async (root) => {
      mkdirSync(path.join(root, 'alpha', 'sources', 'notes'), { recursive: true });
      writeFileSync(
        path.join(root, 'alpha', 'brief.md'),
        '---\nschema_version: 5\ntitle: alpha\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: AL\nvisibility: agent-visible\n---\n\nThe zebra ledger.\n',
      );
      const result = await searchCommand.run({ query: 'zebra' }, context(root, 'owner'));

      const line = readLine(stateDir);
      expect(line.hits).toBe(result.hits.length);
      expect(line.callerKind).toBe('owner');
    });
  });

  it('still returns the search result when the state dir is unwritable', async () => {
    const sentinel = path.join(stateDir, 'sentinel');
    writeFileSync(sentinel, 'x');
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(path.join(sentinel, 'nested'));

    await withEmptyActiveRoot(async (root) => {
      const result = await searchCommand.run({ query: 'anything' }, context(root, 'owner'));

      expect(result.query).toBe('anything');
    });
  });
});
