import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

import { relatedContext, type RelatedInput } from '../search/related.js';
import { writeCharter } from './visibility.js';
import { refreshInto, scaffold } from './workspace-index/fixture.js';

interface RelatedFixture {
  root(): string;
  related(input: Partial<RelatedInput> & { text: string }): ReturnType<typeof relatedContext>;
}

/** Registers the hooks that build the miniature active root and its graph for each test. */
export function useRelatedFixture(): RelatedFixture {
  let dir: string;
  let root: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'aw-related-'));
    root = path.join(dir, 'active');
    dbPath = path.join(dir, 'graph.sqlite3');
    scaffold(root);
    writeCharter(root);
    (await refreshInto(dbPath, root)).db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    root: () => root,
    related: (input) => relatedContext({ dbPath, activeRoot: root, ...input }),
  };
}
