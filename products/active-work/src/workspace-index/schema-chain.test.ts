import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph, SCHEMA_VERSION } from '../session-index/graph.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-schema-chain-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the workspace migration chain', () => {
  it('is followed only by the plan record and cache blob tables', () => {
    expect(SCHEMA_VERSION).toBe(1005);
  });

  it('creates an empty cache_blob table on a fresh graph', () => {
    const { db } = openGraph(path.join(dir, 'graph.sqlite3'));

    const table = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE name = 'cache_blob'")
      .get();
    db.close();

    expect(table?.name).toBe('cache_blob');
  });
});
