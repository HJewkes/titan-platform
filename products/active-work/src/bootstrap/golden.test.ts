import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assembleBootstrap, type BootstrapInput, type BootstrapMetadata } from './prompt.js';
import type { LoopRetriever } from './loop-context.js';
import type { RelatedHit } from '../search/related.js';
import { withTempActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';

/**
 * Golden output for two fixture initiatives: one bare, one that renders every
 * optional section. Section order and every byte are pinned, so a refactor of
 * the assembly that reorders or rewords a section fails here.
 */

const SLUG = 'sample-initiative';
const NOW = new Date('2026-05-12T16:00:00Z');

function hit(ref: string, initiative: string, title: string): RelatedHit {
  return {
    ref,
    class: 'notes',
    initiative,
    title,
    path: null,
    excerpt: null,
    byteOffset: 0,
    byteLength: 10,
  };
}

const fixedRetriever =
  (hits: RelatedHit[]): LoopRetriever =>
  async (input) => ({
    hits: hits.filter((h) => !(input.exclude ?? []).includes(h.ref)).slice(0, input.limit),
    degraded: [],
    query: { terms: [], expression: '' },
  });

/** Wall-clock lines are the only ones that may differ between runs. */
function withoutClock(prompt: string): string {
  return prompt
    .replace(/^- Today: .*$/m, '- Today: <today>')
    .replace(/^- Bootstrap: .*$/m, '- Bootstrap: <now>');
}

function headings(prompt: string): string[] {
  return prompt.split('\n').filter((line) => line.startsWith('# '));
}

function stableMetadata(metadata: BootstrapMetadata): Partial<BootstrapMetadata> {
  const rest: Partial<BootstrapMetadata> = { ...metadata };
  delete rest.bootstrap_at;
  delete rest.timings_ms;
  return rest;
}

const quietInput = (activeRoot: string): BootstrapInput => ({
  activeRoot,
  slug: SLUG,
  now: NOW,
  includeLiveStatus: false,
  siblingProbe: async () => [],
  noteRelevance: () => [],
  loopRetriever: fixedRetriever([]),
  hitLog: async () => null,
});

async function writeFile(root: string, rel: string, lines: string[]): Promise<void> {
  const file = path.join(root, SLUG, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join('\n'), 'utf8');
}

async function pauseBrief(root: string): Promise<void> {
  const briefPath = path.join(root, SLUG, 'brief.md');
  const raw = await fs.readFile(briefPath, 'utf8');
  await fs.writeFile(
    briefPath,
    raw.replace(
      /^state: focused$/m,
      'state: paused\npaused_since: 2026-05-01\nrestart_trigger: after the release',
    ),
  );
}

async function writeSessions(root: string): Promise<void> {
  await writeFile(root, 'sessions/2026-05-08-0900-opener1.md', [
    '---',
    'session_id: opener1',
    'started: 2026-05-08T09:00:00Z',
    'ended: 2026-05-08T10:00:00Z',
    'track: canonical',
    'next_steps:',
    '  - id: n1',
    '    text: "Rewrite the picker"',
    '    kind: prose',
    '---',
    '',
    'opened\n',
  ]);
  await writeFile(root, 'sessions/2026-05-11-0900-closer1.md', [
    '---',
    'session_id: closer1',
    'started: 2026-05-11T09:00:00Z',
    'ended: 2026-05-11T16:00:00Z',
    'track: canonical',
    'next_steps:',
    '  - id: s1',
    '    text: "Mint note refs"',
    '    kind: task',
    "    ref: 'SI-1'",
    '  - id: s2',
    '    text: "Decide the eval harness"',
    '    kind: prose',
    'resolves:',
    '  - ref: 2026-05-08-0900-opener1#n1',
    '    outcome: abandoned',
    '    note: too many dependencies',
    '---',
    '',
    '- Closed the picker thread\n',
  ]);
  await writeFile(root, 'sessions/2026-05-12-1000-side1.md', [
    '---',
    'session_id: side1',
    'started: 2026-05-12T10:00:00Z',
    'ended: 2026-05-12T11:00:00Z',
    'track: sidecar',
    'no_loops: true',
    '---',
    '',
    '- Side work on docs\n',
  ]);
}

async function writeTasksAndNotes(root: string): Promise<void> {
  await writeFile(root, 'tasks/SI-3.yml', [
    'id: SI-3',
    'title: Finished sample task',
    'priority: 2',
    'status: done',
    'created: 2026-05-01',
    'updated: 2026-05-11',
    'done_at: 2026-05-11',
    '',
  ]);
  await writeFile(root, 'sources/notes/2026-05-01-refs.md', [
    '---',
    'kind: decision',
    'title: Refs are minted at write',
    "created: '2026-05-01'",
    '---',
    '',
    'body\n',
  ]);
}

const fullInput = (activeRoot: string): BootstrapInput => ({
  ...quietInput(activeRoot),
  includeLiveStatus: true,
  liveStatusFetcher: async (branches) =>
    branches.map((b) => ({
      repo: b.repo,
      name: b.name,
      present: true,
      last_commit_iso: '2026-05-11T12:00:00Z',
      ahead: 2,
      behind: 0,
      pr: {
        number: 7,
        state: 'OPEN',
        title: 'Sample PR',
        url: 'https://example.com/pr/7',
      },
    })),
  siblingProbe: async () => [
    {
      lease_id: 'aaaa',
      cwd: '/tmp/example/sample',
      mode: 'launcher',
      pid: 4321,
      started: '2026-05-12T15:48:00Z',
    },
  ],
  noteRelevance: () => [
    {
      ref: 'note:sample-initiative/2026-05-01-refs.md',
      scorePerTerm: 9,
      title: 'Refs are minted at write',
    },
    {
      ref: 'note:example-app/2026-04-01-ids.md',
      scorePerTerm: 9,
      title: 'Ids need a prefix',
    },
  ],
  loopRetriever: fixedRetriever([
    hit('note:example-app/2026-04-02-evals.md', 'example-app', 'Eval harness notes'),
  ]),
  archivedTaskIds: ['SI-0'],
  facet: {
    name: 'sample-docs',
    tags: ['example'],
    body: 'Docs-facing work only.',
  },
});

describe('bootstrap golden output', () => {
  it('renders the bare fixture initiative byte for byte', async () => {
    await withTempActiveRoot(async (root) => {
      const { prompt, metadata } = await assembleBootstrap(quietInput(root));

      expect(headings(prompt)).toMatchInlineSnapshot(`
        [
          "# Why we're doing this",
          "# Sample Initiative",
          "# Open loops",
          "# Last session (2026-05-10, fixture001) — 2 days ago",
          "# Tasks (top 5 open by priority)",
          "# Recently done (last 14 days)",
          "# Open artifacts",
          "# Context",
        ]
      `);
      expect(withoutClock(prompt)).toMatchInlineSnapshot(`
        "Starting a session on \`sample-initiative\` (Sample Initiative).

        # Why we're doing this

        # Sample Initiative

        This fixture exists so other tests can stand up a known-good active root.
        It must always parse cleanly against the v1 schema. If schema changes,
        update this file at the same time.

        Why we care: the bootstrap path, picker, audit, and several command
        implementations need to read from a real-shaped directory tree.

        # Open loops
        Nothing hanging — the 2026-05-10 session asserted the ledger is clear.

        # Last session (2026-05-10, fixture001) — 2 days ago

        - Set up the sample initiative fixture
        - Sketched SI-1 and SI-2
        - Next: nothing — this is a fixture

        # Tasks (top 5 open by priority)
        1. [SI-1] (priority 1, severity high, est 3) First sample task
           done when: It compiles

        # Recently done (last 14 days)
        1 task completed — \`active-work task list sample-initiative --status done --json\`

        # Open artifacts
        Branches:
        - feat/sample (~/code/sample) — scaffolding for sample initiative

        Worktrees (registered):
        - main (default): ~/code/sample

        # Context
        - Today: <today>
        - Bootstrap: <now>
        - Time since last session: 2 days ago

        Work the top task unless redirected. Update tasks via \`active-work task done\` and close the session out via \`active-work wrap\` when wrapping up — it records the session, files the loops you leave open, and stamps the brief in one step.
        "
      `);
      expect(stableMetadata(metadata)).toMatchInlineSnapshot(`
        {
          "brief_title": "Sample Initiative",
          "last_session": {
            "ended": "2026-05-10T16:00:00Z",
            "filename": "2026-05-10-1430-fixture001.md",
          },
          "open_loop_count": 0,
          "open_task_count": 1,
          "recently_done_count": 1,
          "slug": "sample-initiative",
          "time_since_last_session_human": "2 days ago",
        }
      `);
    });
  });

  it('renders every optional section in order for a fully loaded initiative', async () => {
    await withTempActiveRoot(async (root) => {
      await pauseBrief(root);
      await writeSessions(root);
      await writeTasksAndNotes(root);
      writeAgentVisibleBrief(root, 'example-app');

      const { prompt, metadata } = await assembleBootstrap(fullInput(root));

      expect(headings(prompt)).toMatchInlineSnapshot(`
        [
          "# Another session may already be live on this initiative",
          "# Initiative state: paused",
          "# Why we're doing this",
          "# Sample Initiative",
          "# Facet: sample-docs",
          "# Open loops (2 hanging, oldest 1d)",
          "# Abandoned in the last 14 days (1)",
          "# Last session (2026-05-11, closer1) — 1 day ago",
          "# Parallel sessions since then",
          "# Tasks (top 5 open by priority)",
          "# Recently done (last 14 days)",
          "# Archived (housekeeping)",
          "# Durable notes (1)",
          "# From other initiatives",
          "# Open artifacts",
          "# Context",
        ]
      `);
      expect(withoutClock(prompt)).toMatchInlineSnapshot(`
        "Starting a session on \`sample-initiative\` (Sample Initiative), scoped to facet \`sample-docs\`.

        # Another session may already be live on this initiative
        - started 12m ago in \`/tmp/example/sample\` — launched via \`aw\`, process still running (pid 4321).
        Before starting the top task ("First sample task"), ask the user which session owns it. If this is the second session, take distinct scope and record it with \`active-work wrap --track adhoc\` — not \`canonical\`, which would bury the other session's mainline thread in the next bootstrap.

        # Initiative state: paused
        Paused since 2026-05-01 (11 days ago).
        Restart trigger: after the release
        This initiative is \`paused\`, not \`focused\` — confirm with the user before treating its tasks as current work.

        # Why we're doing this

        # Sample Initiative

        This fixture exists so other tests can stand up a known-good active root.
        It must always parse cleanly against the v1 schema. If schema changes,
        update this file at the same time.

        Why we care: the bootstrap path, picker, audit, and several command
        implementations need to read from a real-shaped directory tree.

        # Facet: sample-docs
        Docs-facing work only.

        _Tasks and loops below are filtered to the tags [example]._

        # Open loops (2 hanging, oldest 1d)
        - [1d] SI-1 Mint note refs       (from 2026-05-11, ref 2026-05-11-0900-closer1#s1)
            see: [from \`example-app\`] note:example-app/2026-04-02-evals.md "Eval harness notes"
        - [1d] Decide the eval harness   (from 2026-05-11, ref 2026-05-11-0900-closer1#s2)

        # Abandoned in the last 14 days (1)
        - Rewrite the picker (dropped 2026-05-11)
          why: too many dependencies

        # Last session (2026-05-11, closer1) — 1 day ago

        - Closed the picker thread

        # Parallel sessions since then
        - 2026-05-12 (sidecar, side1) — - Side work on docs

        # Tasks (top 5 open by priority)
        1. [SI-1] (priority 1, severity high, est 3) First sample task
           done when: It compiles

        # Recently done (last 14 days)
        2 tasks completed — \`active-work task list sample-initiative --status done --json\`

        # Archived (housekeeping)
        Moved 1 stale done task(s) to tasks/archive/: SI-0

        # Durable notes (1)
        - [decision] Refs are minted at write (2026-05-01)

        # From other initiatives
        - [from \`example-app\`] Ids need a prefix (\`note:example-app/2026-04-01-ids.md\`)

        # Open artifacts
        Branches (live):
        - feat/sample (~/code/sample) +2/-0 last commit 2026-05-11 PR #7 OPEN
          PR: Sample PR — https://example.com/pr/7

        Worktrees (registered):
        - main (default): ~/code/sample

        # Context
        - Today: <today>
        - Bootstrap: <now>
        - Time since last session: 1 day ago

        Start with the open loops: 2 are still hanging from prior sessions, and unfinished threads take precedence over the backlog. Work them first, citing each one by the \`ref\` printed under "Open loops", and pass every loop you settle to \`active-work wrap --resolves\` with outcome \`done\` or \`abandoned\` — deciding not to do a loop still closes it. Once the loops are handled, or if the user redirects, work the top task by priority. Update tasks via \`active-work task done\` and close the session out via \`active-work wrap\` when wrapping up — it records the session, files the loops you leave open, and stamps the brief in one step.
        "
      `);
      expect(stableMetadata(metadata)).toMatchInlineSnapshot(`
        {
          "brief_title": "Sample Initiative",
          "facet": "sample-docs",
          "last_session": {
            "ended": "2026-05-11T16:00:00Z",
            "filename": "2026-05-11-0900-closer1.md",
          },
          "open_loop_count": 2,
          "open_task_count": 1,
          "recently_done_count": 2,
          "sibling_sessions": 1,
          "slug": "sample-initiative",
          "time_since_last_session_human": "1 day ago",
        }
      `);
    });
  });
});
