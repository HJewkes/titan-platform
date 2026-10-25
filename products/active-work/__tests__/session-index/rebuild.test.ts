import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../src/errors.js';
import { defaultGraphPath, openGraph } from '../../src/session-index/graph.js';
import { rebuildGraph } from '../../src/session-index/rebuild.js';
import { runRefresh } from '../../src/session-index/refresh.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const PRUNED = 'aaaaaaaa-0000-0000-0000-000000000882';
const LIVE = 'bbbbbbbb-0000-0000-0000-000000000882';

let configDir: string;

const transcriptLine = (sessionId: string): string =>
  `${JSON.stringify({
    type: 'user',
    sessionId,
    uuid: `u-${sessionId.slice(0, 8)}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'hello' },
  })}\n`;

beforeEach(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), 'aw-rebuild-'));
  vi.stubEnv('CLAUDE_CONFIG_DIRS', configDir);
  vi.stubEnv('AGENT_CHAT_HOME', path.join(configDir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

function seedLive(sql: string): void {
  const graph = openGraph(defaultGraphPath());
  graph.db.exec(sql);
  graph.db.close();
}

function rows(sql: string): unknown[] {
  const graph = openGraph(defaultGraphPath());
  try {
    return graph.db.prepare(sql).all();
  } finally {
    graph.db.close();
  }
}

describe('rebuildGraph', () => {
  it('refuses a .next a stopped rebuild left behind, and --resume continues it', () =>
    withEmptyActiveRoot(async () => {
      seedLive('SELECT 1');
      openGraph(`${defaultGraphPath()}.next`).db.close();

      await expect(rebuildGraph()).rejects.toBeInstanceOf(ConfigError);
      const resumed = await rebuildGraph({ resume: true });

      expect(resumed.swapped).toBe(true);
      expect(existsSync(`${defaultGraphPath()}.next`)).toBe(false);
    }));

  it('carries PR forge columns and GitHub review verdicts into the new file, but not chat verdicts', () =>
    withEmptyActiveRoot(async () => {
      seedLive(`
        INSERT INTO pr (pr_ref, number, repo, state, merged_at, outcome_checked_at)
          VALUES ('pr:acme/demo#7', 7, 'acme/demo', 'merged', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z');
        INSERT INTO pr_review (source_key, surface, verdict, ts, number, pr_ref) VALUES
          ('gh:pr:acme/demo#7:2026-07-01', 'gh', 'approved', '2026-07-01T00:00:00Z', 7, 'pr:acme/demo#7'),
          ('chat:tool-1:0', 'chat', 'approved', '2026-07-01T00:00:00Z', 7, 'pr:acme/demo#7');
      `);

      const rebuilt = await rebuildGraph();

      expect(rebuilt).toMatchObject({ swapped: true, carried: { pr: 1, pr_review: 1 } });
      expect(rows('SELECT pr_ref, state, merged_at, outcome_checked_at FROM pr')).toEqual([
        {
          pr_ref: 'pr:acme/demo#7',
          state: 'merged',
          merged_at: '2026-07-01T00:00:00Z',
          outcome_checked_at: '2026-07-02T00:00:00Z',
        },
      ]);
      expect(rows('SELECT surface FROM pr_review')).toEqual([{ surface: 'gh' }]);
      const marker = JSON.parse(readFileSync(`${defaultGraphPath()}.swapped`, 'utf8')) as {
        inode: string;
        backup: string;
      };
      expect(marker.inode).toBe(String(statSync(defaultGraphPath(), { bigint: true }).ino));
      expect(marker.backup).toBe(rebuilt.backupPath);
      expect(existsSync(rebuilt.backupPath!)).toBe(true);
    }));

  it("keeps a pruned session's fact at offset 0 on its own transcript id after the rebuild", () =>
    withEmptyActiveRoot(async () => {
      const projects = path.join(configDir, 'projects', 'demo');
      mkdirSync(projects, { recursive: true });
      const pruned = path.join(projects, `${PRUNED}.jsonl`);
      writeFileSync(pruned, transcriptLine(PRUNED), 'utf8');
      await runRefresh({ dbPath: defaultGraphPath(), skipPrOutcomes: true });
      rmSync(pruned);
      writeFileSync(path.join(projects, `${LIVE}.jsonl`), transcriptLine(LIVE), 'utf8');
      await runRefresh({ dbPath: defaultGraphPath(), skipPrOutcomes: true });
      const factsOf = (sessionId: string) =>
        rows(
          `SELECT f.byte_offset, t.source_key FROM fact f JOIN transcript t ON t.source_id = f.transcript_id
            WHERE f.session_id = '${sessionId}'`,
        ) as { byte_offset: number; source_key: string }[];
      const before = factsOf(PRUNED);

      const rebuilt = await rebuildGraph();

      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ byte_offset: 0 });
      expect(rebuilt.swapped).toBe(true);
      expect(rebuilt.nextTotals.facts).toBe(rebuilt.liveTotals.facts);
      expect(factsOf(PRUNED)).toEqual(before);
      expect(factsOf(LIVE).map((fact) => fact.source_key)).toEqual([expect.stringContaining(LIVE)]);
    }));

  it('turn totals that differ swap nothing and leave .next in place unless forced', () =>
    withEmptyActiveRoot(async () => {
      seedLive(`
        INSERT INTO turn (prompt_id, session_id, turn_index, started_at, duration_ms)
          VALUES ('p-orphan', 'sess-gone', 0, '2026-07-01T00:00:00Z', 1000);
      `);
      const inodeBefore = statSync(defaultGraphPath()).ino;

      const refused = await rebuildGraph();
      const inodeAfterRefusal = statSync(defaultGraphPath()).ino;
      const nextKept = existsSync(`${defaultGraphPath()}.next`);
      const forced = await rebuildGraph({ resume: true, force: true });

      expect(refused).toMatchObject({ swapped: false, backupPath: null });
      expect(refused.liveTotals.turns).toBe(1);
      expect(refused.nextTotals.turns).toBe(0);
      expect(inodeAfterRefusal).toBe(inodeBefore);
      expect(nextKept).toBe(true);
      expect(forced.swapped).toBe(true);
      expect(statSync(defaultGraphPath()).ino).not.toBe(inodeBefore);
    }));
});
