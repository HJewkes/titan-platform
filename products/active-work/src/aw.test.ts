import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as ChildProcessModule from 'node:child_process';
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EXIT, NotFoundError } from './errors.js';
import { PROFILE_ROOT_ENV } from './utils/profile-dir.js';

import { helpText, main, type AwDeps } from './aw.js';
import { openSlugOrInit } from './launcher-open.js';
import resumeCommand from './commands/resume.js';

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: spawnSpy,
}));

function fakeDeps(): { [K in keyof AwDeps]: ReturnType<typeof vi.fn<AwDeps[K]>> } {
  return {
    exit: vi.fn<AwDeps['exit']>(async () => undefined),
    open: vi.fn<AwDeps['open']>(),
    launch: vi.fn<AwDeps['launch']>(),
  };
}

describe('openSlugOrInit (TP-356 reviewer nit)', () => {
  let isTTY: boolean | undefined;

  beforeEach(() => {
    isTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true, writable: true });
  });

  it('rethrows a NotFoundError with the kebab-case hint appended for an invalid-slug miss on a TTY', async () => {
    process.stdin.isTTY = true;
    const original = "No initiative matches 'New_Thing'. Known: a, b";
    const open = vi.fn().mockRejectedValue(new NotFoundError(original, { reason: 'no_match' }));

    await expect(openSlugOrInit('New_Thing', false, open)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NotFoundError);
      if (!(err instanceof NotFoundError)) return false;
      expect(err.code).toBe(66);
      expect(err.message).toContain(original);
      expect(err.message).toContain(
        'To create it, use a lowercase kebab-case slug (e.g. my-new-thing).',
      );
      return true;
    });
  });
});

describe('aw --profile', () => {
  let profilesRoot: string;
  let stderr: MockInstance<typeof process.stderr.write>;
  let deps: ReturnType<typeof fakeDeps>;

  beforeEach(() => {
    profilesRoot = mkdtempSync(path.join(tmpdir(), 'aw-profiles-'));
    mkdirSync(path.join(profilesRoot, 'agents'));
    mkdirSync(path.join(profilesRoot, 'server'));
    vi.stubEnv(PROFILE_ROOT_ENV, profilesRoot);
    spawnSpy.mockClear();
    deps = fakeDeps();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    vi.unstubAllEnvs();
    rmSync(profilesRoot, { recursive: true, force: true });
  });

  it.each([['--profile', 'ghost'], ['--profile=ghost']])(
    'exits non-zero listing the existing profiles before launching for %s',
    async (...flag) => {
      await main(['node', 'aw', 'example-app', ...flag], deps);

      expect(deps.exit).toHaveBeenCalledWith(EXIT.USAGE);
      const message = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(message).toContain('unknown profile "ghost"');
      expect(message).toContain('agents, server');
      expect(deps.open).not.toHaveBeenCalled();
      expect(deps.launch).not.toHaveBeenCalled();
    },
  );

  it('rejects an unknown profile for resume before looking the session up', async () => {
    const lookup = vi.spyOn(resumeCommand, 'run').mockResolvedValue({
      session_id: 'abc123',
      cwd: profilesRoot,
      source: 'active-work',
    });

    await main(['node', 'aw', 'resume', 'abc123', '--profile', 'ghost'], deps);

    expect(deps.exit).toHaveBeenCalledWith(EXIT.USAGE);
    expect(lookup).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    lookup.mockRestore();
  });

  it('documents --profile in the help text', () => {
    const help = helpText();

    expect(help).toContain('aw <slug> --profile <name>');
    expect(help).toContain('--profile=<name>');
    expect(help).toContain('aw resume <session_id> [--no-rc] [--profile <name>]');
  });
});
