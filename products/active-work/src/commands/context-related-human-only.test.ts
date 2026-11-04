import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph } from '../session-index/graph.js';
import { refreshWorkspace } from '../workspace-index/refresh.js';
import { runRelated } from './context-related.js';

/**
 * A spawn renders related hits into an agent's prompt, so the charter's
 * human-only initiatives must never reach it (TP-4140).
 */

const CHARTER = 'claude-channels/sources/autonomy/charter.md';

let dir: string;
let root: string;
let dbPath: string;

function writeFile(relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function writeInitiative(slug: string, prefix: string): void {
  writeFile(
    `${slug}/brief.md`,
    `---\nschema_version: 5\ntitle: ${slug} initiative\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: ${prefix}\n---\n\nThe ${slug} initiative.\n`,
  );
  writeFile(
    `${slug}/sources/notes/2026-09-02-${slug}-ledger.md`,
    `---\nkind: process\ntitle: The ${slug} ledger lesson\ncreated: 2026-09-02\n---\n\nA lesson about the quarterly ledger.\n`,
  );
}

async function indexFixture(): Promise<void> {
  writeInitiative('fixture-open', 'FO');
  writeInitiative('fixture-other', 'FX');
  writeInitiative('fixture-private', 'FP');
  const graph = openGraph(dbPath);
  try {
    await refreshWorkspace(graph, { activeRoot: root });
  } finally {
    graph.db.close();
  }
}

function related(trigger?: 'spawn') {
  return runRelated(
    { for: 'the quarterly ledger lesson', initiative: 'fixture-open', ...(trigger ? { trigger } : {}) },
    { activeRoot: root, dbPath, hitLog: async () => null, ensureFresh: async () => 'fresh' },
  );
}

function initiativesOf(result: Awaited<ReturnType<typeof related>>): (string | null)[] {
  return [...new Set(result.hits.map((hit) => hit.initiative))].sort();
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-related-human-only-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  await indexFixture();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('context.related and the charter', () => {
  it('a spawn is served no row from a human-only initiative', async () => {
    writeFile(CHARTER, '---\nhuman_only_initiatives:\n  - fixture-private\n---\n');

    const untriggered = await related();
    const spawn = await related('spawn');

    // The fixture is live: an untriggered query still finds the human-only note.
    expect(initiativesOf(untriggered)).toContain('fixture-private');
    expect(initiativesOf(spawn)).toEqual(['fixture-open', 'fixture-other']);
    expect(JSON.stringify(spawn.hits)).not.toContain('fixture-private');
  });

  it('a spawn with an unreadable charter is served only its own initiative', async () => {
    writeFile(CHARTER, '---\nhuman_only: [fixture-private\n---\n');

    const spawn = await related('spawn');

    expect(initiativesOf(spawn)).toEqual(['fixture-open']);
    expect(spawn.degraded).toEqual([
      expect.objectContaining({ source: 'charter', reason: 'unreadable' }),
    ]);
  });
});
