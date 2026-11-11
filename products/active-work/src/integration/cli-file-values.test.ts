import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCommand, registry } from '../registry/index.js';
import { runCliInProcess } from '../test-support/cli-runner.js';

const fixture = defineCommand<{ tag?: string[] }, unknown>({
  name: 'fixture-file-echo',
  description: 'Echo parsed args back',
  args: z.object({ tag: z.array(z.string()).optional() }),
  result: z.unknown(),
  cli: {
    options: {
      tag: { long: '--tag', description: 'Repeat for each value, or pass @<file> with one per line' },
    },
  },
  run: (args) => Promise.resolve(args),
});

describe('array flag @<file> values', () => {
  let dir = '';
  const tmp = (): string => (dir = mkdtempSync(path.join(os.tmpdir(), 'aw-file-values-')));
  const run = (args: string[]) =>
    runCliInProcess(['--json', 'fixture-file-echo', ...args], { ACTIVE_ROOT: path.join(dir, 'root') });

  beforeAll(() => {
    if (!registry.has(fixture.name)) registry.register(fixture);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('an @file stands for its non-blank lines, trimmed, after the values before it', async () => {
    const file = path.join(tmp(), 'tags.txt');
    writeFileSync(file, 'a\n\n  b  \n', 'utf8');

    const res = await run(['--tag', 'x', '--tag', `@${file}`]);

    expect(res.status).toBe(0);
    expect(z.object({ data: z.unknown() }).parse(JSON.parse(res.stdout)).data).toEqual({ tag: ['x', 'a', 'b'] });
  });

  it('an @file with no values is a usage error naming the file', async () => {
    const file = path.join(tmp(), 'tags.txt');
    writeFileSync(file, '\n  \n', 'utf8');

    const res = await run(['--tag', `@${file}`]);

    expect(res.status).toBe(64);
    expect(res.stderr).toContain(`--tag @${file}: the file has no values`);
  });

  it('an unreadable @file is a usage error naming the file', async () => {
    const file = path.join(tmp(), 'missing.txt');

    const res = await run(['--tag', `@${file}`]);

    expect(res.status).toBe(64);
    expect(res.stderr).toContain('cannot read it (ENOENT)');
    expect(res.stderr).toContain(file);
  });

  it('a comma in an @file line is refused like a comma in the flag', async () => {
    const file = path.join(tmp(), 'tags.txt');
    writeFileSync(file, 'a,b\n', 'utf8');

    const res = await run(['--tag', `@${file}`]);

    expect(res.status).toBe(64);
    expect(res.stderr).toContain('--tag a,b: pass --tag a --tag b');
  });
});
