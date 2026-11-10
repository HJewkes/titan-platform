import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { claudeTranscriptRoots, discoverAllTranscripts } from '@titan-design/session-read';
import { AUDIT_FACET, FACET_TABLE } from '@titan-design/session-graph';
import { EXTRACT_VERSION } from '@titan-design/session-read';
import type { CommandContext } from '../registry/types.js';
import minerCost from './miner-cost.js';
import minerStatus from './miner-status.js';
import { defaultGraphPath, openGraph } from '../session-index/graph.js';
import { runRefresh } from '../session-index/refresh.js';
import { WORKSPACE_SPAN_SOURCE_BASE } from '../workspace-index/schema.js';
import { FIXTURE_LINES, SESSION, renderTranscript } from '../test-support/session-index/fixture.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { mirrorRoot, mirrorRoots } from '../test-support/fixtures/mirror-roots.js';

vi.mock('@titan-design/session-read', async (importOriginal) =>
  (await import('../test-support/fixtures/mirror-roots.js')).withMirrors(importOriginal),
);

let configRoot: string;

beforeEach(() => {
  configRoot = mkdtempSync(path.join(os.tmpdir(), 'aw-miner-status-'));
  // A closed daemon: status must not reach the operator's live one.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mirrorRoots.length = 0;
  rmSync(configRoot, { recursive: true, force: true });
});

/** One config dir per account, holding `count` transcripts each. */
/** Request ids carry the session id, so the per-transcript rename keeps them unique. */
const BILLED_LINES = FIXTURE_LINES.map((line, i) =>
  line.type === 'assistant' ? { ...line, requestId: `req-${SESSION}-${i}` } : line,
);

function writeTranscripts(projectsRoot: string, label: string, count: number): void {
  const project = path.join(projectsRoot, 'demo');
  mkdirSync(project, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const body = renderTranscript(BILLED_LINES).replaceAll(SESSION, `${label}-${i}`);
    writeFileSync(path.join(project, `${i}.jsonl`), body, 'utf8');
  }
}

function writeCorpus(accounts: Record<string, number>): void {
  const configDirs = Object.entries(accounts).map(([name, count]) => {
    const configDir = path.join(configRoot, name);
    writeTranscripts(path.join(configDir, 'projects'), name, count);
    return configDir;
  });
  vi.stubEnv('CLAUDE_CONFIG_DIRS', configDirs.join(path.delimiter));
}

/** Each account's transcripts in a mirror of host `mac`. */
function writeMirror(accounts: Record<string, number>): void {
  for (const [account, count] of Object.entries(accounts)) {
    const mirror = mirrorRoot(path.join(configRoot, 'mirror'), account);
    writeTranscripts(mirror.root, `mac-${account}`, count);
    mirrorRoots.push(mirror);
  }
}

function ctx(): CommandContext {
  return { activeRoot: '', warnings: [], format: 'json' };
}

function status(): ReturnType<typeof minerStatus.run> {
  return minerStatus.run({}, ctx());
}

describe('miner status', () => {
  it('miner status reports per-account counts', async () => {
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 1, agents: 2 });
      await runRefresh({ skipPrOutcomes: true, skipWorkspace: true });

      const result = await status();

      expect(result.transcripts.byAccount).toEqual({ default: 1, agents: 2 });
      expect(result.facetBacklog).toBe(0);
      expect(result.episodeBacklog).toBe(0);
    });
  });

  it('counts a mirror of another host apart from the local account of the same name', async () => {
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 1, agents: 2 });
      writeMirror({ agents: 1 });
      const transcripts = await discoverAllTranscripts(claudeTranscriptRoots());
      await runRefresh({ transcripts, skipPrOutcomes: true, skipWorkspace: true });

      const result = await status();

      expect(result.transcripts.byAccount).toEqual({ default: 1, agents: 2, 'mac/agents': 1 });
    });
  });

  it('counts sessions with no episodes as episode backlog', async () => {
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 2 });
      await runRefresh({ skipPrOutcomes: true, skipWorkspace: true });
      const db = new Database(defaultGraphPath());
      db.prepare('DELETE FROM episode').run();
      db.close();

      const result = await status();

      expect(result.episodeBacklog).toBe(2);
    });
  });

  it('reports the daemon stall gauge and tolerates a daemon that predates it', async () => {
    const index = {
      indexing: true,
      pending: false,
      lastRunAt: '2026-09-24T00:00:00Z',
      lastDurationMs: 1200,
      consecutiveErrors: 0,
    };
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 1 });
      await runRefresh({ skipPrOutcomes: true, skipWorkspace: true });
      const answer = (body: object) =>
        vi.fn(async () => new Response(JSON.stringify({ ok: true, index: body })));

      vi.stubGlobal('fetch', answer({ ...index, lastMaxLoopStallMs: 412 }));
      const current = await status();
      vi.stubGlobal('fetch', answer(index));
      const older = await status();

      expect(minerStatus.result.parse(current).daemon?.lastMaxLoopStallMs).toBe(412);
      expect(minerStatus.result.parse(older).daemon).toMatchObject({ indexing: true });
    });
  });

  it('sums spans across both tables and reports the workspace backfill', async () => {
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 1 });
      await runRefresh({ skipPrOutcomes: true, skipWorkspace: true });
      const graph = openGraph(defaultGraphPath());
      const span = { field: 'body', byteOffset: 0, byteLength: 9 };
      const transcriptSpans = graph.db.prepare('SELECT 1 FROM search_span').all().length;
      graph.workspaceSpans.index(
        { ...span, ownerRef: 'note:a/b.md', sourceId: WORKSPACE_SPAN_SOURCE_BASE + 1 },
        'synthetic',
      );
      graph.spans.index(
        { ...span, ownerRef: 'note:a/c.md', sourceId: WORKSPACE_SPAN_SOURCE_BASE + 2 },
        'synthetic',
      );
      graph.db.close();

      const result = await status();

      expect(result.counts.spans).toBe(transcriptSpans + 2);
      expect(result.workspaceBackfill).toEqual({
        state: 'in_progress',
        legacySpans: 1,
        workspaceSpans: 1,
        pendingFiles: 1,
      });
      expect(minerStatus.result.parse(result).workspaceBackfill.state).toBe('in_progress');
    });
  });

  it('counts indexed transcripts whose audit facet is stale as backlog', async () => {
    await withEmptyActiveRoot(async () => {
      writeCorpus({ '.claude': 2 });
      await runRefresh({ skipPrOutcomes: true, skipWorkspace: true });
      const db = new Database(defaultGraphPath());
      db.prepare('UPDATE transcript_facet SET version = 0').run();
      db.close();

      const result = await status();

      expect(result.facetBacklog).toBe(2);
    });
  });

  it('cost coverage and miner status agree on the facet backlog', async () => {
    await withEmptyActiveRoot(async () => {
      const graph = openGraph(defaultGraphPath());
      const facet = (key: string, version: number): void => {
        const { sourceId } = graph.transcripts.ensure(key);
        graph.db
          .prepare(
            `INSERT INTO ${FACET_TABLE} (transcript_id, facet, version, indexed_to) VALUES (?, ?, ?, 0)`,
          )
          .run(sourceId, AUDIT_FACET, version);
      };
      graph.transcripts.ensure('~/synthetic/no-facet.jsonl');
      facet('~/synthetic/stale-facet.jsonl', EXTRACT_VERSION - 1);
      facet('~/synthetic/current-facet.jsonl', EXTRACT_VERSION);
      graph.transcripts.ensure('~/synthetic/gone.jsonl');
      graph.transcripts.markStatus('~/synthetic/gone.jsonl', 'missing', 'file deleted');
      graph.transcripts.ensure('~/synthetic/broken.jsonl');
      graph.transcripts.markStatus('~/synthetic/broken.jsonl', 'quarantined', 'unparseable');
      graph.db.close();

      const statusBacklog = (await status()).facetBacklog;
      const cost = await minerCost.run({}, ctx());

      expect(statusBacklog).toBe(2);
      expect(cost.coverage.facetBacklog).toBe(statusBacklog);
    });
  });
});
