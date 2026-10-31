import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { v1ToV2Artifacts } from '../../src/migrations/v1-to-v2-artifacts.js';

let activeRoot: string;

beforeEach(() => {
  activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-mig-v2-null-'));
});

afterEach(() => {
  rmSync(activeRoot, { recursive: true, force: true });
});

async function writeArtifacts(slug: string, yaml: string): Promise<string> {
  const dir = path.join(activeRoot, slug);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'artifacts.yml');
  await writeFile(file, yaml, 'utf8');
  return file;
}

describe('v1ToV2Artifacts null list elements', () => {
  it('does not throw on a null element and migrates the valid entries around it', async () => {
    const file = await writeArtifacts(
      'sample',
      [
        'branches:',
        '  - null',
        '  - repo: org/one',
        '    name: feat/a',
        '    last_commit: abc',
        'stashes:',
        '  - ~',
        '  - repo: org/one',
        '    message: wip',
        'prs:',
        '  - null',
        '',
      ].join('\n'),
    );

    await expect(v1ToV2Artifacts.run(activeRoot)).resolves.toBeUndefined();

    const next = YAML.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(next.branches).toEqual([{ repo: 'org/one', name: 'feat/a' }]);
    expect(next.stashes).toEqual([{ repo: 'org/one', label: 'wip' }]);
    expect(next.prs).toBeUndefined();
  });

  it('does not throw when every element is null', async () => {
    await writeArtifacts('sample', 'branches:\n  - null\nstashes:\n  - null\n');
    await expect(v1ToV2Artifacts.run(activeRoot)).resolves.toBeUndefined();
  });

  it('migrates valid inputs exactly as before', async () => {
    const file = await writeArtifacts(
      'sample',
      [
        'branches:',
        '  - repo: org/one',
        '    name: feat/a',
        '    note: keep',
        '    last_commit: abc',
        'stashes:',
        '  - repo: org/one',
        '    message: wip',
        '    created: 2026-01-01',
        '    sha: deadbeef',
        'prs:',
        '  - number: 7',
        '    repo: org/one',
        '    title: Thing',
        '',
      ].join('\n'),
    );

    await v1ToV2Artifacts.run(activeRoot);

    const next = YAML.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(next.branches).toEqual([{ repo: 'org/one', name: 'feat/a', note: 'keep' }]);
    expect(next.stashes).toEqual([{ repo: 'org/one', label: 'wip', sha: 'deadbeef' }]);
    expect(next.prs).toBeUndefined();
    const log = await readFile(path.join(activeRoot, '.migrations.log'), 'utf8');
    expect(log).toContain('#7 (org/one) Thing');
  });
});
