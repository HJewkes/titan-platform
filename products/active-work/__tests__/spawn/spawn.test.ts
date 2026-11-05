import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSpawnCommand } from '../../src/spawn/args.js';
import type { SpawnDeps } from '../../src/spawn/run.js';

const READINGS =
  'account: agents (least-used; max(5h,7d): default 72% [5h 72 7d 40], agents 31% [5h 12 7d 31])';
const EXHAUSTED =
  'account: none (least-used; default over ceiling 93%, agents stale 420s, work auth_fail)';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aw-spawn-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake agent-chat that records argv (NUL-separated) and stdin, then prints `output` and exits `status`. */
function fakeAgentChat(output: string, status = 0): string {
  const path = join(dir, 'agent-chat');
  writeFileSync(
    path,
    `#!/bin/sh\n` +
      `: >"${dir}/argv"\n` +
      `for a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\n` +
      `cat >"${dir}/stdin"\n` +
      `printf '%s\\n' '${output}'\n` +
      `exit ${status}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const recordedArgv = (): string[] => readFileSync(join(dir, 'argv'), 'utf8').split('\0').slice(0, -1);
const recordedStdin = (): string => readFileSync(join(dir, 'stdin'), 'utf8');

interface Run {
  stdout: string;
  stderr: string;
  code: number | undefined;
}

async function spawnCli(bin: string, args: string[], stdin = 'Synthetic brief'): Promise<Run> {
  const run: Run = { stdout: '', stderr: '', code: undefined };
  const deps: SpawnDeps = {
    env: { AGENT_CHAT_BIN: bin },
    cwd: dir,
    readStdin: async () => stdin,
    stdout: (text) => (run.stdout += text),
    stderr: (text) => (run.stderr += text),
    exit: async (code) => {
      run.code = code;
    },
  };
  const program = new Command().exitOverride();
  attachSpawnCommand(program, deps);
  await program.parseAsync(['spawn', ...args], { from: 'user' });
  return run;
}

describe('active-work spawn', () => {
  it('asks agent-chat for the least-used account when no --account is given', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');

    await spawnCli(bin, ['synthetic-coord', 'synthetic-coordinator', '--brief-stdin']);

    expect(recordedArgv()).toEqual([
      'agent',
      'spawn',
      'synthetic-coord',
      'synthetic-coordinator',
      '--account',
      'least-used',
      '--brief-stdin',
    ]);
  });

  it('passes an explicit account through unchanged', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');

    await spawnCli(bin, ['synthetic-coord', 'synthetic-coordinator', '--account', 'work', '--brief-stdin']);

    const argv = recordedArgv();
    expect(argv.slice(argv.indexOf('--account'), argv.indexOf('--account') + 2)).toEqual(['--account', 'work']);
  });

  it('sends host, briefing, surface and remote control as agent-chat flags', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');

    await spawnCli(bin, [
      'synthetic-coord',
      'synthetic-coordinator',
      '--host',
      'synthetic-host',
      '--briefing',
      'synthetic-slug',
      '--surface',
      'headless',
      '--remote-control',
      '--brief-stdin',
    ]);

    expect(recordedArgv()).toEqual([
      'agent',
      'spawn',
      'synthetic-coord',
      'synthetic-coordinator',
      '--briefing',
      'synthetic-slug',
      '--host',
      'synthetic-host',
      '--account',
      'least-used',
      '--surface',
      'headless',
      '--remote-control',
      '--brief-stdin',
    ]);
  });

  it("prints agent-chat's account readings and spawn line verbatim and exits 0", async () => {
    const bin = fakeAgentChat(`${READINGS}\nSpawned synthetic-coord`);

    const run = await spawnCli(bin, ['synthetic-coord', 'synthetic-coordinator', '--brief-stdin']);

    expect(run.stdout).toBe(`${READINGS}\nSpawned synthetic-coord\n`);
    expect(run.code).toBe(0);
  });

  it('exits 1 and prints the readings when every account is refused', async () => {
    const bin = fakeAgentChat(`${EXHAUSTED}\nNot spawned: account_exhausted`, 1);

    const run = await spawnCli(bin, ['synthetic-coord', 'synthetic-coordinator', '--brief-stdin']);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(EXHAUSTED);
    expect(run.stdout).toBe('');
  });

  it('sends the --brief-file bytes on stdin and never in argv', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');
    const brief = 'Line one of the synthetic brief\nLine two\n';
    writeFileSync(join(dir, 'brief.md'), brief);

    await spawnCli(bin, ['synthetic-coord', 'synthetic-coordinator', '--brief-file', 'brief.md']);

    expect(recordedStdin()).toBe(brief);
    expect(recordedArgv().join(' ')).not.toContain('Line one');
  });

  it('refuses a spawn with no brief before calling agent-chat', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');

    await expect(spawnCli(bin, ['synthetic-coord', 'synthetic-coordinator'])).rejects.toThrow(/brief is required/);
  });
});
