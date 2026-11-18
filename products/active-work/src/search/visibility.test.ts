import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { assembleBootstrap } from '../bootstrap/prompt.js';
import contextGraph from '../commands/context-graph.js';
import { runRelated } from '../commands/context-related.js';
import searchCommand from '../commands/search.js';
import type { CommandContext } from '../registry/types.js';
import { invokeTool } from '../server/mcp.js';
import { defaultGraphPath, openGraph } from '../session-index/graph.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { ownerShown, writeCharter } from '../test-support/visibility.js';
import { refreshWorkspace } from '../workspace-index/refresh.js';
import { searchWorkspace } from './index.js';

/**
 * Owner-only initiatives stay out of everything an agent can search or read (TP-5453 P6).
 * Most cases index every initiative while it is agent-visible and only then hide it,
 * which is the state an index built before P6 is in until P7 rebuilds it.
 */

const QUERY = 'quarterly ledger lesson';
const HitsSchema = z.object({ hits: z.array(z.object({ initiative: z.string().nullable() })) });
const CountSchema = z.object({ n: z.number() });
const PRIVATE_BRIEF =
  '---\nschema_version: 5\ntitle: hidden\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: PN\n---\n\nThe quarterly ledger, privately.\n';
const BROKEN_BRIEF = '---\nvisibility: [agent-visible\n---\n';

function writeFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function writeBrief(root: string, slug: string, prefix: string): void {
  writeFile(
    root,
    `${slug}/brief.md`,
    `---\nschema_version: 5\ntitle: ${slug} initiative\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: ${prefix}\nvisibility: agent-visible\n---\n\nThe ${slug} initiative and its quarterly ledger.\n`,
  );
}

function writeInitiative(root: string, slug: string, prefix: string): void {
  writeBrief(root, slug, prefix);
  writeFile(
    root,
    `${slug}/sources/notes/2026-09-02-${slug}-ledger.md`,
    `---\nkind: process\ntitle: The ${slug} quarterly ledger lesson\ncreated: 2026-09-02\n---\n\nA lesson about the quarterly ledger.\n`,
  );
  writeFile(
    root,
    `${slug}/tasks/${prefix}-1.yml`,
    `id: ${prefix}-1\ntitle: Write the quarterly ledger lesson\npriority: 1\nstatus: open\ncreated: 2026-09-02\nupdated: 2026-09-02\ndone_at: null\n`,
  );
}

async function refresh(root: string): Promise<void> {
  const graph = openGraph(defaultGraphPath());
  try {
    await refreshWorkspace(graph, { activeRoot: root });
  } finally {
    graph.db.close();
  }
}

/** alpha stays visible; private-notes and broken are indexed visible, then hidden without a refresh. */
async function staleIndex(root: string): Promise<void> {
  writeCharter(root);
  writeInitiative(root, 'alpha', 'AL');
  writeInitiative(root, 'private-notes', 'PN');
  writeInitiative(root, 'broken', 'BR');
  await refresh(root);
  writeFile(root, 'private-notes/brief.md', PRIVATE_BRIEF);
  writeFile(root, 'broken/brief.md', BROKEN_BRIEF);
}

function agentContext(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json', caller: 'agent' };
}

function initiativesOf(hits: readonly { initiative: string | null }[]): (string | null)[] {
  return [...new Set(hits.map((hit) => hit.initiative))].sort();
}

describe('owner-only initiatives in agent-facing search', () => {
  it('the index still holds the hidden initiatives, so the filter below is what withholds them', async () => {
    await withEmptyActiveRoot(async (root) => {
      await staleIndex(root);

      const { hits } = await searchWorkspace(QUERY, { activeRoot: root, visible: await ownerShown(root) });

      expect(initiativesOf(hits)).toEqual(['alpha', 'broken', 'private-notes']);
    });
  });

  it('search returns no hit from an owner-only or unparsable-brief initiative', async () => {
    await withEmptyActiveRoot(async (root) => {
      await staleIndex(root);

      const result = await searchCommand.run({ query: QUERY }, agentContext(root));

      expect(initiativesOf(result.hits)).toEqual(['alpha']);
    });
  });

  it('the MCP search tool returns no hit from an owner-only or unparsable-brief initiative', async () => {
    await withEmptyActiveRoot(async (root) => {
      await staleIndex(root);

      const out = await invokeTool('active__search', { query: QUERY });

      expect(out.isError).toBe(false);
      const data = out.envelope.ok ? HitsSchema.parse(out.envelope.data) : null;
      expect(data && initiativesOf(data.hits)).toEqual(['alpha']);
      expect(JSON.stringify(out.envelope)).not.toMatch(/private-notes|broken/);
    });
  });

  it('context related serves no owner-only row, with or without a trigger', async () => {
    await withEmptyActiveRoot(async (root) => {
      await staleIndex(root);
      const deps = { activeRoot: root, hitLog: async () => null, ensureFresh: async () => 'fresh' as const };

      const plain = await runRelated({ for: QUERY, initiative: 'alpha' }, deps);
      const spawn = await runRelated({ for: QUERY, initiative: 'alpha', trigger: 'spawn' }, deps);

      expect(initiativesOf(plain.hits)).toEqual(['alpha']);
      expect(initiativesOf(spawn.hits)).toEqual(['alpha']);
    });
  });

  it('the cross-initiative context graph scan skips an owner-only initiative', async () => {
    await withEmptyActiveRoot(async (root) => {
      await staleIndex(root);

      const all = await contextGraph.run({ id: 'PN-1' }, agentContext(root));

      expect(all.initiatives_scanned).toEqual(['alpha']);
      expect(all.subject).toBeNull();
    });
  });
});

describe('a session inside an owner-only initiative', () => {
  // No signal an agent cannot set tells the owner's session from a spawned one, so reads of
  // the session's own initiative by path stay as they were; only shared, cross-initiative
  // readers filter (owner clarification, 2026-11-12).
  it('still bootstraps with its own tasks and notes, read from files', async () => {
    await withEmptyActiveRoot(async (root) => {
      await staleIndex(root);
      await refresh(root);

      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: 'private-notes',
        now: new Date('2026-09-03T00:00:00Z'),
        includeLiveStatus: false,
      });

      expect(prompt).toContain('PN-1');
      expect(prompt).toContain('The private-notes quarterly ledger lesson');
    });
  });

  it('still traces its own ids when it names itself to context graph', async () => {
    await withEmptyActiveRoot(async (root) => {
      await staleIndex(root);

      const named = await contextGraph.run({ id: 'PN-1', slug: 'private-notes' }, agentContext(root));

      expect(named.subject).toEqual(expect.objectContaining({ kind: 'task', slug: 'private-notes' }));
    });
  });
});

describe('the workspace indexer and owner-only initiatives', () => {
  it('keeps only the initiative row of an owner-only initiative: no task, note or brief span', async () => {
    await withEmptyActiveRoot(async (root) => {
      await staleIndex(root);

      await refresh(root);

      const graph = openGraph(defaultGraphPath());
      try {
        const count = (sql: string) => CountSchema.parse(graph.db.prepare(sql).get()).n;
        const { hits } = await searchWorkspace(QUERY, { graph, activeRoot: root, visible: await ownerShown(root) });
        expect(initiativesOf(hits)).toEqual(['alpha']);
        expect(count("SELECT count(*) AS n FROM initiative WHERE slug = 'private-notes'")).toBe(1);
        expect(count("SELECT count(*) AS n FROM note WHERE initiative = 'private-notes'")).toBe(0);
        expect(count("SELECT count(*) AS n FROM workspace_task WHERE path LIKE 'private-notes/%'")).toBe(0);
        expect(count("SELECT count(*) AS n FROM workspace_task WHERE path LIKE 'alpha/%'")).toBe(1);
      } finally {
        graph.db.close();
      }
    });
  });
});
