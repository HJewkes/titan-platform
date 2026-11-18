import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../registry/types.js';
import { defaultGraphPath, openGraph } from '../session-index/graph.js';
import { writeCharter } from '../test-support/visibility.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { refreshWorkspace } from '../workspace-index/refresh.js';
import doctor from './doctor.js';
import focus from './focus.js';
import unfocus from './unfocus.js';

/**
 * doctor, focus and unfocus name no initiative withheld from an agent caller and leave the
 * owner's view as it was (TP-5556 S2b, TP-5746, TP-5747). `alpha` and `target` are agent-visible;
 * `private-notes` declares nothing, so it is owner-only; `garden-plan` declares itself
 * agent-visible but the charter lists it human-only, so it is withheld too.
 */

const VISIBLE = 'alpha';
const HIDDEN = 'private-notes';
const HUMAN_ONLY = 'garden-plan';
const TARGET = 'target';
const WITHHELD = [HIDDEN, HUMAN_ONLY];

function writeFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function briefText(slug: string, rank: number, visibility: string): string {
  const prefix = slug.slice(0, 2).toUpperCase();
  return `---\nschema_version: 5\ntitle: ${slug}\nupdated: 2026-09-01\nstate: focused\nrank: ${rank}\ntask_prefix: ${prefix}\n${visibility}---\n\nBody.\n`;
}

function writeBrief(root: string, slug: string, rank: number, visibility: string): void {
  writeFile(root, `${slug}/brief.md`, briefText(slug, rank, visibility));
}

function seed(root: string): void {
  writeCharter(root, [HUMAN_ONLY]);
  writeBrief(root, VISIBLE, 1, 'visibility: agent-visible\n');
  writeBrief(root, HIDDEN, 2, '');
  writeBrief(root, HUMAN_ONLY, 3, 'visibility: agent-visible\n');
  writeBrief(root, TARGET, 4, 'visibility: agent-visible\n');
}

const context = (activeRoot: string, caller: CommandContext['caller']): CommandContext => ({
  activeRoot,
  warnings: [],
  format: 'json',
  caller,
});

function checkDetail(report: { checks: { name: string; detail: string }[] }, name: string): string {
  return report.checks.find((check) => check.name === name)?.detail ?? '';
}

async function indexWorkspace(activeRoot: string): Promise<void> {
  const graph = openGraph(defaultGraphPath());
  try {
    await refreshWorkspace(graph, { activeRoot });
  } finally {
    graph.db.close();
  }
}

describe('doctor for an agent caller', () => {
  it('names no withheld initiative to an agent and names every one to the owner', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      for (const slug of [VISIBLE, ...WITHHELD]) writeFile(root, `${slug}/sessions/2026-09-01-bad.md`, 'no frontmatter\n');

      const agent = JSON.stringify(await doctor.run({}, context(root, 'agent')));
      const owner = JSON.stringify(await doctor.run({}, context(root, 'owner')));

      for (const slug of WITHHELD) expect(agent).not.toContain(slug);
      expect(agent).toContain(`${VISIBLE}/sessions/2026-09-01-bad.md`);
      for (const slug of WITHHELD) expect(owner).toContain(`${slug}/sessions/2026-09-01-bad.md`);
    });
  });

  it('names no initiative gone from the root through the workspace index', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      writeBrief(root, 'archived-plans', 5, 'visibility: agent-visible\n');
      await indexWorkspace(root);
      rmSync(path.join(root, 'archived-plans'), { recursive: true, force: true });

      const agent = await doctor.run({}, context(root, 'agent'));
      const owner = await doctor.run({}, context(root, 'owner'));

      expect(JSON.stringify(agent)).not.toContain('archived-plans');
      expect(checkDetail(owner, 'workspace-index')).toContain('initiative:archived-plans -> archived-plans/brief.md');
    });
  });

  it('reports a lease sweep failure under a withheld initiative as a count, without its path', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const leases = path.join(root, '.sessions', HIDDEN);
      mkdirSync(leases, { recursive: true });
      chmodSync(leases, 0o000);
      try {
        const agent = checkDetail(await doctor.run({}, context(root, 'agent')), 'session-leases');
        const owner = checkDetail(await doctor.run({}, context(root, 'owner')), 'session-leases');

        expect(agent).toContain('could not sweep the leases of 1 initiative hidden from this caller');
        expect(agent).not.toContain(HIDDEN);
        expect(owner).toContain(HIDDEN);
      } finally {
        chmodSync(leases, 0o755);
      }
    });
  });
});

describe('focus and unfocus renumbering', () => {
  it('focus names only the shifted initiatives an agent may see, and every one to the owner', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const agent = await focus.run({ slug: TARGET, rank: 1 }, context(root, 'agent'));
      await unfocus.run({ slug: TARGET }, context(root, 'owner'));
      const owner = await focus.run({ slug: TARGET, rank: 1 }, context(root, 'owner'));

      expect(agent.shifted.map((move) => move.slug)).toEqual([VISIBLE]);
      expect(owner.shifted.map((move) => move.slug)).toEqual([VISIBLE, HIDDEN, HUMAN_ONLY]);
    });
  });

  it('unfocus names only the renumbered initiatives an agent may see, and every one to the owner', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const agent = await unfocus.run({ slug: VISIBLE }, context(root, 'agent'));
      await focus.run({ slug: VISIBLE, rank: 1 }, context(root, 'owner'));
      const owner = await unfocus.run({ slug: VISIBLE }, context(root, 'owner'));

      expect(agent.renumbered.map((move) => move.slug)).toEqual([TARGET]);
      expect(owner.renumbered.map((move) => move.slug)).toEqual([HIDDEN, HUMAN_ONLY, TARGET]);
    });
  });

  it('withholds a move from a caller no surface marked', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const result = await focus.run({ slug: TARGET, rank: 1 }, context(root, undefined));

      expect(result.shifted.map((move) => move.slug)).toEqual([VISIBLE]);
    });
  });

  it('focus names no owner-only initiative whose directory is a symlink to an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      writeFile(root, '.store/linked-plans/brief.md', briefText('linked-plans', 5, ''));
      symlinkSync(path.join(root, '.store', 'linked-plans'), path.join(root, 'linked-plans'), 'dir');

      const agent = await focus.run({ slug: TARGET, rank: 5 }, context(root, 'agent'));
      await focus.run({ slug: TARGET, rank: 4 }, context(root, 'owner'));
      const owner = await focus.run({ slug: TARGET, rank: 5 }, context(root, 'owner'));

      expect(agent.shifted).toEqual([]);
      expect(owner.shifted.map((move) => move.slug)).toEqual(['linked-plans']);
    });
  });
});
