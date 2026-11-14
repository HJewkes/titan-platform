import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../registry/types.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { writeCharter } from '../test-support/visibility.js';
import { minerKeys, OWNER_ONLY_KEY, redactCostReport, redactOutcomeReport } from './_miner-redact.js';

/**
 * Miner cost and outcomes name no initiative withheld from agents to a non-owner caller, and leave
 * the owner's report as it was (TP-5556 S2a, census row 18). `alpha` declares itself agent-visible;
 * `private-notes` declares nothing, so it is owner-only.
 */

const VISIBLE = 'alpha';
const HIDDEN = 'private-notes';

function writeBrief(root: string, slug: string, visibility: string): void {
  const target = path.join(root, slug, 'brief.md');
  mkdirSync(path.dirname(target), { recursive: true });
  const prefix = slug.slice(0, 2).toUpperCase();
  writeFileSync(
    target,
    `---\nschema_version: 5\ntitle: ${slug}\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: ${prefix}\n${visibility}---\n\nBody.\n`,
    'utf8',
  );
}

function seed(root: string): void {
  writeCharter(root);
  writeBrief(root, VISIBLE, 'visibility: agent-visible\n');
  writeBrief(root, HIDDEN, '');
}

const context = (activeRoot: string, caller?: CommandContext['caller']): CommandContext => ({
  activeRoot,
  warnings: [],
  format: 'json',
  ...(caller && { caller }),
});

const costBucket = (key: string, costUsd: number) => ({ key, requests: 2, sessions: 1, costUsd });

function costReport() {
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
    byInitiative: [
      costBucket(VISIBLE, 1),
      costBucket(HIDDEN, 2),
      costBucket(`active-work:${HIDDEN}`, 3),
      costBucket('repo:tools', 4),
    ],
    topSessions: [session('s1', HIDDEN), session('s2', 'repo:tools')],
  };
}

function outcomeReport() {
  const bucket = (key: string, merged: number) => ({
    key,
    assignments: 2,
    merged,
    done: 0,
    costUsd: 4,
    usdPerMerged: 4 / merged,
    usdPerDone: null as number | null,
    requests: 8,
    requestsPerFinished: 8 / merged,
  });
  return { byInitiative: [bucket(VISIBLE, 1), bucket(HIDDEN, 2)] };
}

const keysAndCost = (rows: readonly { key: string; costUsd: number }[]) => rows.map((row) => [row.key, row.costUsd]);

describe('miner cost and outcomes for a non-owner (census row 18)', () => {
  it('folds owner-only initiatives into one unnamed bucket and keeps the totals', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const redacted = redactCostReport(costReport(), await minerKeys(context(root, 'agent')));

      expect(JSON.stringify(redacted)).not.toContain(HIDDEN);
      expect(keysAndCost(redacted.byInitiative)).toEqual([
        [VISIBLE, 1],
        ['repo:tools', 4],
        [OWNER_ONLY_KEY, 5],
      ]);
      expect(redacted.topSessions.map((row) => row.initiative)).toEqual([OWNER_ONLY_KEY, 'repo:tools']);
    });
  });

  it('recomputes an outcome bucket rate over the folded sums', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const report = outcomeReport();
      report.byInitiative.push({ ...report.byInitiative[1], key: 'archived-plans', merged: 6, usdPerMerged: 4 / 6 });

      const redacted = redactOutcomeReport(report, await minerKeys(context(root)));

      expect(redacted.byInitiative.map((bucket) => [bucket.key, bucket.usdPerMerged])).toEqual([
        [VISIBLE, 4],
        [OWNER_ONLY_KEY, 1],
      ]);
    });
  });

  it('folds an archived owner-only initiative, which is no longer in the root', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const report = { byInitiative: [costBucket('archived-plans', 7)], topSessions: [] };

      const redacted = redactCostReport(report, await minerKeys(context(root, 'agent')));

      expect(keysAndCost(redacted.byInitiative)).toEqual([[OWNER_ONLY_KEY, 7]]);
    });
  });

  it('folds every initiative key when the root cannot be read', async () => {
    await withEmptyActiveRoot(async (root) => {
      const report = costReport();

      const redacted = redactCostReport(report, await minerKeys(context(path.join(root, 'missing'), 'agent')));

      expect(keysAndCost(redacted.byInitiative)).toEqual([
        ['repo:tools', 4],
        [OWNER_ONLY_KEY, 6],
      ]);
    });
  });

  it('shows an other: key whose basename is an owner-only slug only as other', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const report = {
        byInitiative: [costBucket(`other:${HIDDEN}`, 1), costBucket('other:scratch', 2), costBucket(`other:${VISIBLE}`, 3)],
        topSessions: [],
      };

      const redacted = redactCostReport(report, await minerKeys(context(root, 'agent')));

      expect(keysAndCost(redacted.byInitiative)).toEqual([
        ['other', 3],
        [`other:${VISIBLE}`, 3],
      ]);
    });
  });
});

describe('miner cost and outcomes for the owner', () => {
  it('leaves every key as it is', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const report = costReport();
      report.byInitiative.push(costBucket(`other:${HIDDEN}`, 5), costBucket('archived-plans', 6));

      const redacted = redactCostReport(report, await minerKeys(context(root, 'owner')));

      expect(redacted).toEqual(report);
    });
  });
});
