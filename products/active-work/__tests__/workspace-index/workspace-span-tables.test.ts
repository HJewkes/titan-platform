import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, runMigrations, SpanFtsTables } from '@titan-design/store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph, SCHEMA_VERSION } from '../../src/session-index/graph.js';
import {
  MIGRATIONS,
  WORKSPACE_SPAN_SOURCE_BASE,
  WORKSPACE_SPANS_MIGRATION_VERSION,
} from '../../src/workspace-index/schema.js';

/**
 * Migration 1003 (TP-4680) adds empty `workspace_span` + `workspace_fts`
 * tables. It must upgrade a graph written by the previous build without
 * touching a row it already holds, and reopening must change nothing.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-workspace-span-tables-'));
  dbPath = path.join(dir, 'graph.sqlite3');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A graph as the 1002 build left it, holding a transcript span, a workspace span and a note row. */
function seedSchema1002Graph(): void {
  const db = openDatabase(dbPath);
  runMigrations(
    db,
    MIGRATIONS.filter((m) => m.version < WORKSPACE_SPANS_MIGRATION_VERSION),
  );
  const spans = new SpanFtsTables(db);
  spans.index(
    { ownerRef: 'session:s1', field: 'prompt', sourceId: 1, byteOffset: 0, byteLength: 9 },
    'synthetic transcript prompt',
  );
  spans.index(
    {
      ownerRef: 'note:alpha/n.md',
      field: 'body',
      sourceId: WORKSPACE_SPAN_SOURCE_BASE + 1,
      byteOffset: 0,
      byteLength: 9,
    },
    'synthetic workspace note',
  );
  db.prepare(
    "INSERT INTO note (path, note_ref, initiative, filename, kind, title) VALUES ('alpha/n.md', 'note:alpha/n.md', 'alpha', 'n.md', 'fyi', 'N')",
  ).run();
  db.close();
}

function read<T>(sql: string): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

const existingRows = () => ({
  spans: read('SELECT * FROM search_span ORDER BY span_id'),
  fts: read("SELECT rowid FROM search_fts WHERE search_fts MATCH 'synthetic' ORDER BY rowid"),
  notes: read('SELECT * FROM note ORDER BY path'),
});

const schemaObjects = () =>
  read<{ name: string; sql: string | null }>(
    'SELECT name, sql FROM sqlite_master ORDER BY type, name',
  );

describe('migration 1003: workspace span tables', () => {
  it('is the top of the chain', () => {
    expect(SCHEMA_VERSION).toBe(1003);
  });

  it('upgrades a 1002 graph to contentless-delete workspace tables and keeps every existing row', () => {
    seedSchema1002Graph();
    const before = existingRows();

    openGraph(dbPath).db.close();

    const fts = schemaObjects().find((o) => o.name === 'workspace_fts');
    expect(fts?.sql).toContain('contentless_delete=1');
    expect(schemaObjects().map((o) => o.name)).toEqual(
      expect.arrayContaining(['workspace_span', 'idx_workspace_span_source']),
    );
    expect(existingRows()).toEqual(before);
    expect(before.spans).toHaveLength(2);
    expect(read('SELECT * FROM workspace_span')).toEqual([]);
  });

  it('reopening an upgraded graph changes neither the schema nor the migration record', () => {
    seedSchema1002Graph();
    openGraph(dbPath).db.close();
    const schema = schemaObjects();
    const migrations = read('SELECT * FROM _migration ORDER BY version');

    openGraph(dbPath).db.close();

    expect(schemaObjects()).toEqual(schema);
    expect(read('SELECT * FROM _migration ORDER BY version')).toEqual(migrations);
  });
});
