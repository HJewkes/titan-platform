import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { indexTranscript } from '@titan-design/session-graph';
import type { CommandContext } from '../registry/types.js';
import { defaultGraphPath, openGraph } from '../session-index/graph.js';
import { callerVisibility } from '../sessions/visibility.js';
import { SNAPSHOT, TREE } from '../test-support/fixtures/loop-ledger.js';
import { FIXTURE_LINES, renderTranscript } from '../test-support/session-index/fixture.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import artifactList from './artifact-list.js';
import audit from './audit.js';
import inventory from './inventory.js';
import list from './list.js';
import loopBoard from './loop-board.js';
import noteList from './note-list.js';
import search from './search.js';
import sourceList from './source-list.js';
import taskList from './task-list.js';

/**
 * The cross-initiative list verbs withhold owner-only initiatives from an agent caller and
 * leave the owner's plain terminal and the daemon's RPC as they were (TP-5453 P6b).
 * `alpha` declares itself agent-visible; `private-notes` declares nothing, so it is owner-only.
 */

const VISIBLE = 'alpha';
const HIDDEN = 'private-notes';
const HIDDEN_WARNING = '1 owner-only initiative hidden from an agent caller';

function writeFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function writeInitiative(root: string, slug: string, prefix: string, visibility: string): void {
  writeFile(
    root,
    `${slug}/brief.md`,
    `---\nschema_version: 5\ntitle: ${slug} initiative\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: ${prefix}\n${visibility}---\n\nBody.\n`,
  );
  writeFile(
    root,
    `${slug}/tasks/${prefix}-1.yml`,
    `id: ${prefix}-1\ntitle: A ${slug} task\npriority: 1\nstatus: open\ncreated: 2026-09-02\nupdated: 2026-09-02\ndone_at: null\n`,
  );
  writeFile(
    root,
    `${slug}/sources/notes/2026-09-02-${slug}.md`,
    `---\nkind: fyi\ntitle: A ${slug} note\ncreated: 2026-09-02\n---\n\nBody.\n`,
  );
  writeFile(root, `${slug}/sources/pr-1-${slug}.md`, `# A ${slug} source\n`);
  writeFile(root, `${slug}/artifacts.yml`, 'branches: []\nstashes: []\nworktrees: []\n');
}

function seed(root: string): void {
  writeInitiative(root, VISIBLE, 'AL', 'visibility: agent-visible\n');
  writeInitiative(root, HIDDEN, 'PN', '');
}

function agent(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json', caller: 'agent' };
}

function owner(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

async function indexUnclaimedTranscript(root: string): Promise<void> {
  const absolutePath = path.join(root, 'session.jsonl');
  writeFileSync(absolutePath, renderTranscript(FIXTURE_LINES), 'utf8');
  const graph = openGraph(defaultGraphPath());
  try {
    const transcript = { projectDir: 'demo', absolutePath, displayPath: absolutePath, subagentId: null, account: null };
    await indexTranscript(graph, transcript, { indexToolSpans: false });
  } finally {
    graph.db.close();
  }
}

function slugsOf(rows: readonly { slug: string }[]): string[] {
  return [...new Set(rows.map((row) => row.slug))].sort();
}

describe('cross-initiative list verbs for an agent caller', () => {
  it('task list across all initiatives hides owner-only initiatives from an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = agent(root);

      const { tasks } = await taskList.run({ all_initiatives: true }, ctx);

      expect(slugsOf(tasks)).toEqual([VISIBLE]);
      expect(ctx.warnings).toEqual([HIDDEN_WARNING]);
    });
  });

  it('task list across all initiatives still shows the owner every initiative', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = owner(root);

      const { tasks } = await taskList.run({ all_initiatives: true }, ctx);

      expect(slugsOf(tasks)).toEqual([VISIBLE, HIDDEN]);
      expect(ctx.warnings).toEqual([]);
    });
  });

  it('task list by name still reads an owner-only initiative, as a session reads its own', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const { tasks } = await taskList.run({ slug: HIDDEN }, agent(root));

      expect(slugsOf(tasks)).toEqual([HIDDEN]);
    });
  });

  it('note list across all initiatives hides owner-only notes from an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = agent(root);

      const { notes } = await noteList.run({ all_initiatives: true }, ctx);

      expect(slugsOf(notes)).toEqual([VISIBLE]);
      expect(ctx.warnings).toContain(HIDDEN_WARNING);
    });
  });

  it('source list across all initiatives hides owner-only sources and drift from an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const { sources, drift } = await sourceList.run({ all_initiatives: true }, agent(root));

      expect(slugsOf(sources)).toEqual([VISIBLE]);
      expect(slugsOf(drift)).not.toContain(HIDDEN);
    });
  });

  it('artifact list across all initiatives hides owner-only artifacts from an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const { items } = await artifactList.run({ all_initiatives: true }, agent(root));

      expect(slugsOf(items)).toEqual([VISIBLE]);
    });
  });

  it('inventory gives an agent only agent-visible rows and totals, with a hidden count', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = agent(root);

      const result = await inventory.run({}, ctx);

      expect(slugsOf(result.initiatives)).toEqual([VISIBLE]);
      expect(result.totals.total.files).toBe(result.initiatives[0]?.total.files);
      expect(ctx.warnings).toContain(HIDDEN_WARNING);
    });
  });

  it('inventory tells the owner which initiatives are agent-visible', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const result = await inventory.run({}, owner(root));

      expect(result.initiatives.map((row) => [row.slug, row.agent_visible])).toEqual([
        [VISIBLE, true],
        [HIDDEN, false],
      ]);
    });
  });

  it('list hides owner-only initiatives and their titles from an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = agent(root);

      const { sections } = await list.run({}, ctx);

      expect(sections.flatMap((section) => section.items.map((item) => item.slug))).toEqual([VISIBLE]);
      expect(ctx.warnings).toEqual([HIDDEN_WARNING]);
    });
  });

  it('audit hides owner-only initiatives and their parse errors from an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      writeFile(root, 'broken/brief.md', '---\nvisibility: [agent-visible\n---\n');
      const ctx = agent(root);

      const result = await audit.run({}, ctx);

      expect(slugsOf(result.initiatives)).toEqual([VISIBLE]);
      expect(result.parse_errors).toEqual([]);
      expect(ctx.warnings).toEqual(['2 owner-only initiatives hidden from an agent caller']);
    });
  });

  it('loop board hides owner-only loops and their tree-node ids from an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      writeInitiative(root, 'sample-initiative', 'SI', 'visibility: agent-visible\n');
      writeInitiative(root, 'other-initiative', 'OI', '');
      writeFile(root, 'titan-platform/sources/open-loops.yml', SNAPSHOT);
      writeFile(root, 'titan-platform/sources/tech-tree.yml', TREE);

      const forAgent = await loopBoard.run({}, agent(root));
      const forOwner = await loopBoard.run({}, owner(root));

      expect(forAgent.loops.map((loop) => loop.initiative)).not.toContain('other-initiative');
      expect(forAgent.tree?.nodes.flatMap((node) => node.loops)).not.toContain('loop-b');
      expect(forAgent.warnings).toContain('1 loop of owner-only initiatives hidden from an agent caller');
      expect(forOwner.loops.map((loop) => loop.id)).toContain('loop-b');
    });
  });

  it('search gives an agent no transcript hit that names no initiative, and the owner keeps it', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      await indexUnclaimedTranscript(root);

      const forAgent = await search.run({ query: 'build' }, agent(root));
      const forOwner = await search.run({ query: 'build' }, owner(root));

      expect(forAgent.hits.filter((hit) => hit.initiative === null)).toEqual([]);
      expect(forOwner.hits.some((hit) => hit.class === 'transcripts' && hit.initiative === null)).toBe(true);
    });
  });

  it('an agent never sees a row that names no initiative, while the owner does', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const forAgent = await callerVisibility(root, 'agent');
      const forOwner = await callerVisibility(root, undefined);

      expect([forAgent(null), forAgent(VISIBLE), forAgent(HIDDEN)]).toEqual([false, true, false]);
      expect([forOwner(null), forOwner(HIDDEN)]).toEqual([true, true]);
    });
  });
});
