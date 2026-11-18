import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as ChildProcessModule from 'node:child_process';
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EXIT, NotFoundError } from './errors.js';
import { PROFILE_ROOT_ENV } from '@titan-design/anthropic-account/node';

import { helpText, main, type AwDeps } from './aw.js';
import { BUILD_VERSION } from './version.js';
import { openSlugOrInit, runOpenSuccess, spawnClaude } from './launcher-open.js';
import { withTempActiveRoot } from './test-support/test-helpers.js';
import * as paths from './utils/paths.js';
import resumeCommand from './commands/resume.js';

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  const realSpawn: typeof actual.spawn = actual.spawn;
  return {
    ...actual,
    // Only the `claude` launch is stubbed; open's own git/gh probes run for real.
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      args[0] === 'claude' ? spawnSpy(...args) : realSpawn(...args),
  };
});

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

describe('aw --version', () => {
  it.each(['--version', '-V'])('prints the running build version for %s', async (flag) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const deps = fakeDeps();

    await main(['node', 'aw', flag], deps);

    const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
    stdout.mockRestore();
    expect(printed).toBe(`${BUILD_VERSION}\n`);
    expect(printed).not.toBe('0.1.0\n');
    expect(deps.exit).toHaveBeenCalledWith(EXIT.OK);
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

describe('aw launch usage records (TP-6192)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'aw-launch-usage-'));
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(stateDir);
    spawnSpy.mockReset();
    spawnSpy.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function launchDeps(): AwDeps {
    return {
      exit: vi.fn<AwDeps['exit']>(async () => undefined),
      open: (slug, adhoc) => runOpenSuccess({ slug, adhoc }),
      launch: (opened, opts) => spawnClaude(opened, tmpdir(), opts),
    };
  }

  it('writes an aw.launch line whose duration is at least the same slug\'s aw.open total', async () => {
    await withTempActiveRoot(async () => {
      await main(['node', 'aw', 'sample-initiative'], launchDeps());

      const lines = readFileSync(path.join(stateDir, 'usage.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l): { command: string; args: { slug: string }; duration_ms: number; timings_ms?: { total: number } } =>
          JSON.parse(l));
      const open = lines.find((l) => l.command === 'aw.open');
      const launch = lines.find((l) => l.command === 'aw.launch');
      expect(launch?.args.slug).toBe(open?.args.slug);
      expect(open?.timings_ms?.total).toBeGreaterThanOrEqual(0);
      expect(launch?.duration_ms).toBeGreaterThanOrEqual(open?.timings_ms?.total ?? Infinity);
    });
  });

  it('still spawns claude and exits 0 when the state dir is unwritable', async () => {
    const sentinel = path.join(stateDir, 'sentinel');
    writeFileSync(sentinel, 'x');
    vi.spyOn(paths, 'getStateRoot').mockReturnValue(path.join(sentinel, 'nested'));
    const deps = launchDeps();

    await withTempActiveRoot(async () => {
      await main(['node', 'aw', 'sample-initiative'], deps);
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});
