import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

import { relatedContext, type RelatedInput } from '../search/related.js';
import { writeCharter } from './visibility.js';
import { refreshInto, scaffold, writeFile } from './workspace-index/fixture.js';

const unrelatedPrecedent = {
  key: 'transcript:sess-garden:tu-garden',
  source: 'transcript',
  asked_at: '2026-08-01T09:00:00Z',
  session_id: 'sess-garden',
  tool_use_id: 'tu-garden',
  initiative: 'alpha',
  class: 'other',
  header: 'Garden',
  question: 'Water the ferns?',
  options: ['Yes (Recommended)', 'No'],
  recommended: 'Yes (Recommended)',
  answer: 'No',
  pick_type: 'other_option',
  free_text: null,
};

/** A workspace with no ledger reports it as degraded; this seeds one that matches no fixture query. */
export function writeUnrelatedPrecedent(root: string): void {
  writeFile(root, 'alpha/sources/precedents.jsonl', `${JSON.stringify(unrelatedPrecedent)}\n`);
}

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
    writeUnrelatedPrecedent(root);
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
