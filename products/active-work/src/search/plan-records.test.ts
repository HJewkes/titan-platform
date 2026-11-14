import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runRelated } from '../commands/context-related.js';
import { defaultGraphPath, openGraph } from '../session-index/graph.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { writeCharter } from '../test-support/visibility.js';
import { refreshWorkspace } from '../workspace-index/refresh.js';

/**
 * Planning records are searchable workspace classes (TP-5453 P10): a bet's text finds the
 * outcome it serves and the owner's intent lines, and a hidden initiative's records never index.
 */

const BET_TEXT = 'checkout answers from a phone';

function brief(visibility: string): string {
  return `---\nschema_version: 5\ntitle: shop\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: SH\nvisibility: ${visibility}\n---\n\nThe shop initiative.\n`;
}

function write(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

const OUTCOME = (slug: string) =>
  `id: ${slug}/phone-checkout\ninitiative: ${slug}\nstatement: Checkout answers from a phone\nmeasure: terminal scripts per week\nstate: active\n`;

const BET = (slug: string) =>
  `id: ${slug}/B1\ninitiative: ${slug}\nweek: 2026-W47\noutcome: ${slug}/phone-checkout\norder: 1\nselector: ${BET_TEXT}\nprediction:\n  metric: phone checkouts\n  direction: increase\n  baseline: 1\n  expected: 5\n  read_by: 2026-12-01\nstate: selected\n`;

const DIGEST = (slug: string) =>
  [
    '---',
    'schema: titan-intent-digest/v1',
    `slug: ${slug}`,
    `initiative: ${slug}`,
    'built_from: synthetic rows',
    '---',
    '## Standing direction',
    `- I1 2026-11-01 "the checkout answers from a phone first" (quote: msg:aaa111)`,
    '## Reasons',
    '## Ruled out',
    '## Taste',
    '## Open questions',
    '## Superseded',
    '',
  ].join('\n');

function seed(root: string, slug: string, visibility: string): void {
  write(root, `${slug}/brief.md`, brief(visibility));
  write(root, `${slug}/plan/outcomes/phone-checkout.yml`, OUTCOME(slug));
  write(root, `${slug}/plan/bets/B1.yml`, BET(slug));
  write(root, `${slug}/plan/intents/${slug}.md`, DIGEST(slug));
}

async function refresh(root: string): Promise<void> {
  const graph = openGraph(defaultGraphPath());
  try {
    await refreshWorkspace(graph, { activeRoot: root });
  } finally {
    graph.db.close();
  }
}

const deps = (root: string) => ({
  activeRoot: root,
  hitLog: async () => null,
  ensureFresh: async () => 'fresh' as const,
});

describe('planning records in context related', () => {
  it("a bet's text returns its outcome and the owner's intent line", async () => {
    await withEmptyActiveRoot(async (root) => {
      writeCharter(root);
      seed(root, 'shop', 'agent-visible');
      await refresh(root);

      const { hits } = await runRelated({ for: BET_TEXT, initiative: 'shop' }, deps(root));

      const plans = hits.filter((hit) => hit.class === 'plans');
      expect(plans.map((hit) => hit.ref)).toEqual(
        expect.arrayContaining(['plan:shop/phone-checkout', 'plan:shop/intents/shop.md']),
      );
      const intent = plans.find((hit) => hit.ref === 'plan:shop/intents/shop.md');
      expect(intent?.excerpt).toBe('the checkout answers from a phone first');
    });
  });

  it('a human-only initiative indexes no plan record for agents', async () => {
    await withEmptyActiveRoot(async (root) => {
      writeCharter(root);
      seed(root, 'hidden', 'owner-only');
      await refresh(root);

      const graph = openGraph(defaultGraphPath());
      try {
        const n = graph.db.prepare('SELECT COUNT(*) FROM plan_record').pluck().get();
        expect(n).toBe(0);
      } finally {
        graph.db.close();
      }
      const { hits } = await runRelated({ for: BET_TEXT }, deps(root));
      expect(hits.filter((hit) => hit.initiative === 'hidden')).toEqual([]);
    });
  });
});
