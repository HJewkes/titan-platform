import type * as ChildProcess from 'node:child_process';
import type * as Fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof Fs>()),
  existsSync: () => true,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawnSync: () => ({
    status: null,
    signal: null,
    stdout: null,
    stderr: null,
    error: new Error('spawn ENOENT'),
  }),
}));

const { runCli } = await import('./cli-runner.js');

describe('runCli', () => {
  it('returns empty strings and status -1 when the child fails to spawn', () => {
    const result = runCli(['--version']);

    expect(result).toEqual({ status: -1, stdout: '', stderr: '' });
  });
});
