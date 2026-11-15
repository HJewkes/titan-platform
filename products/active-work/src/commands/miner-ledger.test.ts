import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import minerLedger from './miner-ledger.js';
import type { CommandContext } from '../registry/types.js';
import { defaultGraphPath, openGraph } from '../session-index/graph.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { writeCharter } from '../test-support/visibility.js';

const SHOWN_SLUG = 'demo';
const OWNER_ONLY_SLUG = 'private-notes';

/** One implementer session on task T-1 (initiative `initiative`), with a merged PR and an approval. */
function seedGraph(initiative: string): void {
  const graph = openGraph(defaultGraphPath());
  graph.db
    .prepare(
      `INSERT INTO session_origin (session_id, origin_system, depth, profile, agent_name, task_ids, resolved_at)
       VALUES ('sess-1', 'agent-chat', 1, 'implementer', 'impl-1', '["T-1"]', '2026-09-01T00:00:00Z')`,
    )
    .run();
  graph.db.prepare("INSERT INTO task (task_ref, task_id, initiative) VALUES ('task:T-1', 'T-1', ?)").run(initiative);
  graph.db.prepare("INSERT INTO pr (pr_ref, state, merged_at) VALUES ('o/r#5', 'MERGED', '2026-09-01T12:00:00Z')").run();
  graph.edges.assert({ sourceRef: 'session:sess-1', relation: 'linked', targetRef: 'o/r#5' });
  graph.db
    .prepare("INSERT INTO pr_review (source_key, surface, verdict, ts, number, pr_ref) VALUES ('gh:o/r#5:1', 'gh', 'approve', '2026-09-01T11:00:00Z', 5, 'o/r#5')")
    .run();
  graph.db.close();
}

/** A readable charter; the brief for `private-notes` declares nothing, so it is owner-only. */
function seedVisibility(root: string): void {
  writeCharter(root);
  mkdirSync(path.join(root, OWNER_ONLY_SLUG), { recursive: true });
  writeFileSync(path.join(root, OWNER_ONLY_SLUG, 'brief.md'), '---\ntitle: Notes\n---\n', 'utf8');
}

function ctx(format: 'human' | 'json', extra: Partial<CommandContext> = {}): CommandContext {
  return { activeRoot: '', warnings: [], format, caller: 'owner', ...extra };
}

function stderrText(): string {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map((call) => call[0])
    .join('');
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('miner ledger', () => {
  it('prints the session, its agent, the PR and the verdict as text', async () => {
    await withEmptyActiveRoot(async () => {
      seedGraph(SHOWN_SLUG);

      await minerLedger.run({ task: 'T-1' }, ctx('human'));

      const text = stderrText();
      expect(text).toContain('sess-1');
      expect(text).toContain('impl-1');
      expect(text).toContain('o/r#5');
      expect(text).toContain('approve');
    });
  });

  it('returns the ledger rows as json and writes nothing to stderr', async () => {
    await withEmptyActiveRoot(async () => {
      seedGraph(SHOWN_SLUG);

      const result = await minerLedger.run({ task: 'T-1' }, ctx('json'));

      expect(result.task).toBe('T-1');
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        sessionId: 'sess-1',
        agentName: 'impl-1',
        profile: 'implementer',
        prs: [{ prRef: 'o/r#5', state: 'MERGED' }],
        verdicts: [{ prRef: 'o/r#5', verdict: 'approve' }],
      });
      expect(process.stderr.write).not.toHaveBeenCalled();
    });
  });

  it('refuses an agent for a task in an owner-only initiative and serves the owner', async () => {
    await withEmptyActiveRoot(async (root) => {
      seedGraph(OWNER_ONLY_SLUG);
      seedVisibility(root);

      const agent = minerLedger.run({ task: 'T-1' }, ctx('json', { activeRoot: root, caller: 'agent' }));
      const owner = await minerLedger.run({ task: 'T-1' }, ctx('json', { activeRoot: root, caller: 'owner' }));

      await expect(agent).rejects.toThrow('owner-only');
      await expect(agent).rejects.not.toThrow(OWNER_ONLY_SLUG);
      expect(owner.sessions).toHaveLength(1);
    });
  });

  it('serves an agent a task in a shown initiative', async () => {
    await withEmptyActiveRoot(async (root) => {
      seedGraph(SHOWN_SLUG);
      seedVisibility(root);
      mkdirSync(path.join(root, SHOWN_SLUG), { recursive: true });
      writeFileSync(path.join(root, SHOWN_SLUG, 'brief.md'), '---\ntitle: Demo\nvisibility: agent-visible\n---\n', 'utf8');

      const result = await minerLedger.run({ task: 'T-1' }, ctx('json', { activeRoot: root, caller: 'agent' }));

      expect(result.sessions).toHaveLength(1);
    });
  });
});
