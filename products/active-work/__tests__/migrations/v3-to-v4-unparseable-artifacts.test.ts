import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { v3ToV4Worktrees } from '../../src/migrations/v3-to-v4-worktrees.js';

let activeRoot: string;

beforeEach(() => {
  activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-mig-v4-bad-'));
});

afterEach(() => {
  rmSync(activeRoot, { recursive: true, force: true });
});

const BRIEF = [
  '---',
  'schema_version: 1',
  'title: Sample',
  'worktrees:',
  '  main:',
  '    path: /tmp/synthetic/wt',
  '    default: true',
  '---',
  '',
  '# Sample',
  '',
].join('\n');

async function writeInitiative(slug: string, artifacts?: string): Promise<string> {
  const dir = path.join(activeRoot, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'brief.md'), BRIEF, 'utf8');
  if (artifacts !== undefined) await writeFile(path.join(dir, 'artifacts.yml'), artifacts, 'utf8');
  return dir;
}

describe('v3ToV4Worktrees unparseable artifacts.yml', () => {
  it('leaves broken YAML byte-identical and reports it', async () => {
    const content = 'branches: [unclosed\n  - : :\n';
    const dir = await writeInitiative('sample', content);

    await v3ToV4Worktrees.run(activeRoot);

    expect(await readFile(path.join(dir, 'artifacts.yml'), 'utf8')).toBe(content);
    expect(await readFile(path.join(dir, 'brief.md'), 'utf8')).toBe(BRIEF);
    const log = await readFile(path.join(activeRoot, '.migrations.log'), 'utf8');
    expect(log).toContain('v3->v4');
    expect(log).toContain('sample\tSKIPPED');
  });

<<<<<<< HEAD
  it.each([
    ['a scalar', 'just a string\n'],
    ['a list', '- one\n- two\n'],
  ])('leaves an artifacts.yml holding %s byte-identical and reports it', async (_label, content) => {
    const dir = await writeInitiative('sample', content);

    await v3ToV4Worktrees.run(activeRoot);

    expect(await readFile(path.join(dir, 'artifacts.yml'), 'utf8')).toBe(content);
    expect(await readFile(path.join(dir, 'brief.md'), 'utf8')).toBe(BRIEF);
    const log = await readFile(path.join(activeRoot, '.migrations.log'), 'utf8');
    expect(log).toContain('sample\tSKIPPED: artifacts.yml is not a mapping, left untouched');
  });

=======
>>>>>>> origin/main
  it('still migrates the other initiatives', async () => {
    await writeInitiative('bad', 'branches: [unclosed\n');
    const good = await writeInitiative('good');

    await v3ToV4Worktrees.run(activeRoot);

    const next = YAML.parse(await readFile(path.join(good, 'artifacts.yml'), 'utf8')) as {
      worktrees: Array<{ name: string }>;
    };
    expect(next.worktrees.map((w) => w.name)).toEqual(['main']);
  });

  it('migrates a valid artifacts.yml exactly as before', async () => {
    const dir = await writeInitiative('sample', 'branches:\n  - repo: org/one\n    name: feat/a\n');

    await v3ToV4Worktrees.run(activeRoot);

    const next = YAML.parse(await readFile(path.join(dir, 'artifacts.yml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(next.branches).toEqual([{ repo: 'org/one', name: 'feat/a' }]);
    expect(next.worktrees).toEqual([
      {
        path: '/tmp/synthetic/wt',
        repo: '/tmp/synthetic/wt',
        name: 'main',
        default: true,
      },
    ]);
  });
});
