import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBrief } from '../commands/context-brief.js';
import { openGraph } from '../session-index/graph.js';
import { writeCharter } from '../test-support/visibility.js';
import { scaffold, writeFile } from '../test-support/workspace-index/fixture.js';
import { utf8Bytes } from './brief-block.js';
import { briefCode, withCode, type Sleep } from './brief-code.js';

/**
 * A fixture checkout where the named file A imports B and is imported by C. Codewatch is a fetch
 * stub; the clock is an injected sleep, so a deadline is reached without waiting for it.
 */

const A = 'packages/demo/src/a.ts';
const B = 'packages/demo/src/b.ts';
const C = 'packages/demo/src/c.ts';
const NOW = new Date('2026-10-20T12:00:00.000Z');

let dir: string;
let repo: string;

const fileNode = (id: string) => ({ id, kind: 'file', name: path.posix.basename(id), path: id });
const edge = (id: string) => ({ node: fileNode(id), kind: 'imports', weight: 1, values: {} });

function neighbours(inbound: string[], outbound: string[]) {
  return {
    snapshotId: 1,
    node: fileNode(A),
    inbound: inbound.map(edge),
    outbound: [...outbound.map(edge), { ...edge('zod'), node: { ...fileNode('zod'), kind: 'external' } }],
    total: { inbound: inbound.length, outbound: outbound.length + 1 },
  };
}

function serving(data: unknown, asked: string[] = []): typeof fetch {
  return async (url, init) => {
    asked.push(`${String(url)} ${String(init?.body)}`);
    return new Response(JSON.stringify({ ok: true, data }));
  };
}

const refusing: typeof fetch = async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:7433');
};

/** Answers only when the request is aborted, the way a hung loopback daemon does. */
const hanging: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

/** A clock that never reaches any deadline. */
const neverDue: Sleep = () => new Promise(() => {});

/** A clock on which only the deadline of exactly `dueMs` passes; every other one is still ahead. */
function clockAt(dueMs: number, asked: number[] = []): Sleep {
  return (ms) => {
    asked.push(ms);
    return ms === dueMs ? Promise.resolve() : new Promise(() => {});
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-brief-code-'));
  repo = path.join(dir, 'repo');
  writeFile(repo, A, "import { b } from './b.js';\nimport { z } from 'zod';\nexport const a = b;\n");
  writeFile(repo, B, 'export const b = 1;\n');
  writeFile(repo, C, "import { a } from './a.js';\nexport const c = a;\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('briefCode', () => {
  it('lists the file A imports and the file that imports A, one hop', async () => {
    const asked: string[] = [];

    const result = await briefCode([A], { fetch: serving(neighbours([C], [B]), asked), sleep: neverDue, repoRoot: repo });

    expect(result).toEqual({
      lines: [`- ${B} (imported by) ${A}`, `- ${C} (imports) ${A}`],
      refs: [B, C],
      degraded: [],
    });
    expect(asked[0]).toContain('/rpc/node.neighbors');
    expect(asked[0]).toContain('"edge_kinds":["imports"]');
  });

  it('caps the section at six lines', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `packages/demo/src/n${i}.ts`);
    for (const file of many) writeFile(repo, file, 'export {};\n');

    const result = await briefCode([A], { fetch: serving(neighbours(many, [])), sleep: neverDue, repoRoot: repo });

    expect(result.lines).toHaveLength(6);
  });

  it('falls back to the dependencies read from the checkout when codewatch is not answering', async () => {
    const result = await briefCode([A], { fetch: refusing, sleep: neverDue, repoRoot: repo });

    expect(result.lines).toEqual([`- ${B} (imported by) ${A}`]);
    expect(result.degraded).toEqual([expect.objectContaining({ source: 'code', reason: 'no-snapshot' })]);
  });

  it('a silent codewatch still leaves the dependencies before the section deadline', async () => {
    const result = await briefCode([A], { fetch: hanging, sleep: clockAt(500), repoRoot: repo });

    expect(result.lines).toEqual([`- ${B} (imported by) ${A}`]);
    expect(result.degraded).toEqual([expect.objectContaining({ source: 'code', reason: 'no-snapshot' })]);
  });

  it('never runs past 800 ms on the injected clock', async () => {
    const asked: number[] = [];

    const result = await briefCode([A], { fetch: hanging, sleep: clockAt(800, asked), repoRoot: repo });

    expect(Math.max(...asked)).toBe(800);
    expect(result).toEqual({
      lines: [],
      refs: [],
      degraded: [expect.objectContaining({ source: 'code', reason: 'timeout' })],
    });
  });

  it('asks nothing when no file is named', async () => {
    const asked: string[] = [];

    const result = await briefCode([], { fetch: serving(neighbours([], []), asked) });

    expect(result).toEqual({ lines: [], refs: [], degraded: [] });
    expect(asked).toEqual([]);
  });
});

describe('briefCode scoped to the spawn repo', () => {
  it('lists only neighbours that exist in the spawn repo when the snapshot spans two repos', async () => {
    const foreign = 'packages/other/src/elsewhere.ts';

    const result = await briefCode([A], { fetch: serving(neighbours([C, foreign], [B])), sleep: neverDue, repoRoot: repo });

    expect(result.refs).toEqual([B, C]);
  });

  it('lists no codewatch neighbours when the spawn has no repoRoot to check them against', async () => {
    const result = await briefCode([A], { fetch: serving(neighbours([C], [B])), sleep: neverDue });

    expect(result.lines).toEqual([]);
  });

  it('lists no neighbours when the named file is not in the spawn repo', async () => {
    const result = await briefCode(['packages/other/src/a.ts'], { fetch: serving(neighbours([C], [B])), sleep: neverDue, repoRoot: repo });

    expect(result.lines).toEqual([]);
  });
});

describe('briefCode fallback path containment', () => {
  const outside = () => path.join(dir, 'outside.ts');

  beforeEach(() => {
    writeFile(dir, 'outside.ts', "import { b } from './b.js';\n");
  });

  it('refuses a named ../ path', async () => {
    const result = await briefCode(['../outside.ts'], { fetch: refusing, sleep: neverDue, repoRoot: repo });

    expect(result.lines).toEqual([]);
  });

  it('refuses a named absolute path outside the repo', async () => {
    const result = await briefCode([outside()], { fetch: refusing, sleep: neverDue, repoRoot: repo });

    expect(result.lines).toEqual([]);
  });

  it('refuses a named symlink that escapes the repo', async () => {
    symlinkSync(outside(), path.join(repo, 'packages/demo/src/link.ts'));

    const result = await briefCode(['packages/demo/src/link.ts'], { fetch: refusing, sleep: neverDue, repoRoot: repo });

    expect(result.lines).toEqual([]);
  });
});

describe('withCode', () => {
  const empty = { text: '', refs: [], bytes: 0 };

  it('keeps the section inside its byte share however long the paths are', () => {
    const long = `- packages/${'é'.repeat(120)}.ts (imports) ${A}`;

    const lines = Array.from({ length: 6 }, () => long);
    const block = withCode(empty, { lines, refs: lines.map(() => B), degraded: [] }, 2600);

    expect(block.bytes).toBeLessThanOrEqual(800);
    expect(block.bytes).toBe(utf8Bytes(block.text));
    expect(block.text).toContain(long);
  });

  it('never passes the whole budget', () => {
    const workspace = { text: 'x'.repeat(2550), refs: [], bytes: 2550 };

    const code = { lines: [`- ${B} (imported by) ${A}`], refs: [B], degraded: [] };
    expect(withCode(workspace, code, 2600)).toEqual(workspace);
  });
});

describe('context.brief with code neighbours', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = path.join(dir, 'active-work');
    dbPath = path.join(dir, 'graph.sqlite3');
    scaffold(root);
    writeCharter(root);
    const graph = openGraph(dbPath);
    graph.db.prepare('INSERT INTO file (file_ref, repo, path) VALUES (?, ?, ?)').run(`file:demo/${A}`, 'demo', A);
    graph.db
      .prepare('INSERT INTO session (session_id, cwd, ai_title) VALUES (?, ?, ?)')
      .run('alpha-session', path.join(root, 'alpha'), 'Alpha edits a');
    graph.edges.assert({
      sourceRef: 'session:alpha-session',
      relation: 'touched',
      targetRef: `file:demo/${A}`,
      tValid: '2026-10-18T12:00:00.000Z',
    });
    graph.db.close();
  });

  const deps = (code: { fetch: typeof fetch; sleep?: Sleep }) => ({
    activeRoot: root,
    dbPath,
    now: NOW,
    hitLog: async () => null,
    ensureFresh: async () => 'fresh' as const,
    code,
  });

  it('shows neighbours and sessions for the named file before the 2,000 ms deadline', async () => {
    const asked: number[] = [];

    const result = await runBrief(
      { for: `Change \`${A}\`.`, initiative: 'alpha', repoRoot: repo },
      deps({ fetch: serving(neighbours([C], [B])), sleep: clockAt(-1, asked) }),
    );

    expect(Math.max(...asked)).toBe(2000);
    expect(result.degraded).toEqual([]);
    expect(result.text).toContain('## Code neighbours of the named files');
    expect(result.text).toContain(`- ${C} (imports) ${A}`);
    expect(result.text).toContain('## Recent sessions on the named files');
    expect(result.text).toContain('Alpha edits a');
    expect(result.bytes).toBeLessThanOrEqual(2600);
  });

  it('returns what it has once the 2,000 ms deadline passes on the injected clock', async () => {
    const asked: number[] = [];

    const result = await runBrief(
      { for: `Change \`${A}\`.`, initiative: 'alpha', repoRoot: repo },
      deps({ fetch: hanging, sleep: clockAt(2000, asked) }),
    );

    expect(Math.max(...asked)).toBe(2000);
    expect(result.degraded).toContainEqual(expect.objectContaining({ source: 'code', reason: 'timeout' }));
  });
});
