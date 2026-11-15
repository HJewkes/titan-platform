import type Database from 'better-sqlite3';
import { existsSync, promises as fs } from 'node:fs';
import type * as nodeFs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driverOpens = vi.hoisted(() => [] as string[]);

// Both mocks wrap the real thing and only record, so the code under test runs unchanged.
// A graph open is one run of driver constructions on the graph file; a visibility
// verdict is one read of the charter, which only `visibilityFor` does.
vi.mock('better-sqlite3', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof Database }>();
  class Recording extends actual.default {
    constructor(file?: string | Buffer, options?: Database.Options) {
      super(file, options);
      driverOpens.push(String(file));
    }
  }
  return { default: Recording };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn(actual.promises.readFile) } };
});

import { defaultGraphPath, openGraph } from '../session-index/graph.js';
import { assembleBootstrap } from './prompt.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';

/**
 * A bootstrap with several open loops opens the graph and computes the agent
 * visibility verdict once, however many notes and loops it queries (TP-6295).
 */

const SLUG = 'sample-initiative';
const NOW = new Date('2026-05-12T16:00:00Z');

async function writeLoopSession(root: string): Promise<void> {
  const front = [
    '---',
    'session_id: loop-session',
    'started: 2026-05-11T09:00:00Z',
    'ended: 2026-05-11T16:00:00Z',
    'track: canonical',
    'next_steps:',
    '  - id: s1',
    '    text: "Mint note refs"',
    '    kind: prose',
    '  - id: s2',
    '    text: "Decide the eval harness"',
    '    kind: prose',
    '  - id: s3',
    '    text: "Rotate the staging keys"',
    '    kind: prose',
    '---',
    '',
    '- Loop session\n',
  ].join('\n');
  await fs.writeFile(
    path.join(root, SLUG, 'sessions', '2026-05-11-0900-loop-session.md'),
    front,
    'utf8',
  );
}

async function writeNote(root: string): Promise<void> {
  const notes = path.join(root, SLUG, 'sources', 'notes');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(
    path.join(notes, '2026-05-01-refs.md'),
    "---\nkind: fyi\ntitle: Refs\ncreated: '2026-05-01'\n---\n\nMint note refs at write time.\n",
  );
}

const bootstrap = (root: string) =>
  assembleBootstrap({
    activeRoot: root,
    slug: SLUG,
    now: NOW,
    includeLiveStatus: false,
    detectSiblings: false,
    hitLog: async () => null,
  });

const graphOpens = () => driverOpens.filter((file) => file === defaultGraphPath()).length;

const charterReads = () =>
  vi.mocked(fs.readFile).mock.calls.filter(([file]) => String(file).endsWith('charter.md'));

beforeEach(() => {
  driverOpens.length = 0;
  vi.mocked(fs.readFile).mockClear();
});

describe('bootstrap shared graph and verdict', () => {
  it('opens the graph once and computes visibility once for three open loops', async () => {
    await withTempActiveRoot(async (root) => {
      await writeLoopSession(root);
      await writeNote(root);
      openGraph(defaultGraphPath()).db.close();
      const perOpen = graphOpens();
      driverOpens.length = 0;

      await bootstrap(root);

      expect(graphOpens()).toBe(perOpen);
      expect(charterReads()).toHaveLength(1);
    });
  });

  it('degrades to date-ordered notes without creating a missing graph', async () => {
    await withTempActiveRoot(async (root) => {
      await writeLoopSession(root);
      expect(existsSync(defaultGraphPath())).toBe(false);

      const { prompt } = await bootstrap(root);

      expect(prompt).toContain('Mint note refs');
      expect(graphOpens()).toBe(0);
      expect(charterReads()).toHaveLength(1);
    });
  });
});
