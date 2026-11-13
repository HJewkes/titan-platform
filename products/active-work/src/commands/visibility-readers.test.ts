import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CostPerOutcomeReport, CostReport } from '@titan-design/session-analytics';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../doctor/index.js';
import type { CommandContext } from '../registry/types.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { minerHiddenSlugs, OWNER_ONLY_KEY, redactCostReport, redactOutcomeReport } from './_miner-redact.js';
import doctor from './doctor.js';
import focus from './focus.js';
import migrate from './migrate.js';
import unfocus from './unfocus.js';

/**
 * The readers #3648's census left open name no owner-only initiative to an agent caller and leave
 * the owner's view as it was (TP-5556). `alpha` declares itself agent-visible; `private-notes`
 * declares nothing, so it is owner-only.
 */

const VISIBLE = 'alpha';
const HIDDEN = 'private-notes';
const HIDDEN_WARNING = '1 owner-only initiative hidden from a non-owner caller';

function writeFile(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function writeBrief(root: string, slug: string, rank: number, visibility: string): void {
  const prefix = slug.slice(0, 2).toUpperCase();
  writeFile(
    root,
    `${slug}/brief.md`,
    `---\nschema_version: 5\ntitle: ${slug}\nupdated: 2026-09-01\nstate: focused\nrank: ${rank}\ntask_prefix: ${prefix}\n${visibility}---\n\nBody.\n`,
  );
}

function seed(root: string): void {
  writeBrief(root, VISIBLE, 1, 'visibility: agent-visible\n');
  writeBrief(root, HIDDEN, 2, '');
  writeBrief(root, 'target', 3, 'visibility: agent-visible\n');
}

const context = (activeRoot: string, caller?: CommandContext['caller']): CommandContext => ({
  activeRoot,
  warnings: [],
  format: 'json',
  ...(caller && { caller }),
});

function costReport(): CostReport {
  const bucket = (key: string, costUsd: number) => ({ key, requests: 2, sessions: 1, costUsd });
  const session = (sessionId: string, initiative: string) => ({
    sessionId,
    sessionClass: 'adhoc',
    role: 'worker',
    initiative,
    account: 'a',
    requests: 2,
    costUsd: 1,
  });
  return {
    byInitiative: [bucket(VISIBLE, 1), bucket(HIDDEN, 2), bucket(`active-work:${HIDDEN}`, 3), bucket('repo:tools', 4)],
    topSessions: [session('s1', HIDDEN), session('s2', 'repo:tools')],
  } as unknown as CostReport;
}

function outcomeReport(): CostPerOutcomeReport {
  const bucket = (key: string, merged: number) => ({
    key,
    assignments: 2,
    merged,
    done: 0,
    costUsd: 4,
    usdPerMerged: 4 / merged,
    usdPerDone: null,
    requests: 8,
    requestsPerFinished: 8 / merged,
  });
  return { byInitiative: [bucket(VISIBLE, 1), bucket(HIDDEN, 2)] } as unknown as CostPerOutcomeReport;
}

describe('miner cost and outcomes (census row 18)', () => {
  it('folds owner-only initiatives into one unnamed bucket for an agent and keeps the totals', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = context(root, 'agent');
      const report = costReport();

      const hidden = await minerHiddenSlugs(ctx, report.byInitiative.map((bucket) => bucket.key));
      const redacted = redactCostReport(report, hidden);

      expect(JSON.stringify(redacted)).not.toContain(HIDDEN);
      expect(redacted.byInitiative.map((bucket) => [bucket.key, bucket.costUsd])).toEqual([
        [VISIBLE, 1],
        ['repo:tools', 4],
        [OWNER_ONLY_KEY, 5],
      ]);
      expect(redacted.topSessions.map((row) => row.initiative)).toEqual([OWNER_ONLY_KEY, 'repo:tools']);
      expect(ctx.warnings).toEqual([HIDDEN_WARNING]);
    });
  });

  it('recomputes an outcome bucket rate over the folded sums', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = context(root);

      const hidden = await minerHiddenSlugs(ctx, [VISIBLE, HIDDEN]);
      const redacted = redactOutcomeReport(outcomeReport(), hidden);

      expect(redacted.byInitiative.map((bucket) => [bucket.key, bucket.usdPerMerged])).toEqual([
        [VISIBLE, 4],
        [OWNER_ONLY_KEY, 2],
      ]);
    });
  });

  it('leaves the owner every initiative name', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = context(root, 'owner');

      const redacted = redactCostReport(costReport(), await minerHiddenSlugs(ctx, [HIDDEN]));

      expect(redacted).toEqual(costReport());
      expect(ctx.warnings).toEqual([]);
    });
  });
});

describe('doctor (census row 20)', () => {
  function writeMalformedSessions(root: string): void {
    for (const slug of [VISIBLE, HIDDEN]) writeFile(root, `${slug}/sessions/2026-09-01-bad.md`, 'no frontmatter\n');
  }

  it('names no owner-only initiative to an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      writeMalformedSessions(root);
      const ctx = context(root, 'agent');

      const report = await doctor.run({}, ctx);

      expect(JSON.stringify(report)).not.toContain(HIDDEN);
      expect(JSON.stringify(report)).toContain(`${VISIBLE}/sessions/2026-09-01-bad.md`);
      expect(ctx.warnings).toEqual([HIDDEN_WARNING]);
    });
  });

  it('still reports every initiative to the owner', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      writeMalformedSessions(root);

      const report = await runDoctor({ activeRoot: root });

      expect(JSON.stringify(report)).toContain(`${HIDDEN}/sessions/2026-09-01-bad.md`);
    });
  });
});

describe('focus and unfocus renumbering (census row 22b)', () => {
  it('focus names no shifted owner-only initiative to an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = context(root, 'agent');

      const result = await focus.run({ slug: 'target', rank: 1 }, ctx);

      expect(result.shifted.map((move) => move.slug)).toEqual([VISIBLE]);
      expect(ctx.warnings).toEqual([HIDDEN_WARNING]);
    });
  });

  it('unfocus names no renumbered owner-only initiative to an agent, and names it to the owner', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const agent = context(root, 'agent');

      const result = await unfocus.run({ slug: VISIBLE }, agent);
      await focus.run({ slug: VISIBLE, rank: 1 }, context(root, 'owner'));
      const owner = await unfocus.run({ slug: VISIBLE }, context(root, 'owner'));

      expect(result.renumbered.map((move) => move.slug)).toEqual(['target']);
      expect(agent.warnings).toEqual([HIDDEN_WARNING]);
      expect(owner.renumbered.map((move) => move.slug)).toEqual([HIDDEN, 'target']);
    });
  });
});

describe('migrate (census row 22b)', () => {
  it('refuses a caller that is not the owner, since its plan names every initiative', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      await expect(migrate.run({ dry_run: true }, context(root, 'agent'))).rejects.toThrow(
        /only the owner can run it/,
      );
    });
  });
});
