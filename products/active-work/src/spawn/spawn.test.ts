import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSpawnCommand } from './args.js';
import type { SpawnDeps } from './run.js';

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

async function spawnCli(
  bin: string,
  args: string[],
  stdin = 'Synthetic brief',
  extra: Partial<SpawnDeps> = {},
): Promise<Run> {
  const run: Run = { stdout: '', stderr: '', code: undefined };
  const deps: SpawnDeps = {
    ...extra,
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

describe('active-work spawn --task', () => {
  const TASK_ARGS = ['synthetic-coord', 'synthetic-coordinator', '--brief-stdin', '--task', 'synthetic/TP-1'];
  const BLOCK = '## Related to this assignment (2, ranked; open with Read)\n\n- a\n- b';
  const served = {
    text: BLOCK,
    refs: [
      { ref: 'synthetic/notes/a.md', source: 'workspace' as const },
      { ref: 'synthetic/notes/b.md', source: 'workspace' as const },
      { ref: 'packages/demo/src/a.ts', source: 'code' as const },
      { ref: 'packages/demo/src/a.ts', source: 'code' as const },
      { ref: 'sess-full-id', source: 'sessions' as const },
    ],
    bytes: BLOCK.length,
    degraded: [],
  };

  function recorder() {
    const calls: unknown[][] = [];
    const hitLog = async (entries: unknown[]) => {
      calls.push(entries);
      return null;
    };
    return { calls, hitLog };
  }

  it('appends the context.brief block after the brief and logs each ref with task and section', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');
    const { calls, hitLog } = recorder();

    await spawnCli(bin, TASK_ARGS, 'Synthetic brief', { contextBrief: async () => served, hitLog });

    expect(recordedStdin()).toBe(`Synthetic brief\n\n## Retrieved context\n\n${BLOCK}\n`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject([
      { trigger: 'spawn', task: 'synthetic/TP-1', section: 'workspace', ref: 'synthetic/notes/a.md', rank: 1 },
      { trigger: 'spawn', task: 'synthetic/TP-1', section: 'workspace', ref: 'synthetic/notes/b.md', rank: 2 },
      { trigger: 'spawn', task: 'synthetic/TP-1', section: 'code', ref: 'packages/demo/src/a.ts', rank: 1 },
      { trigger: 'spawn', task: 'synthetic/TP-1', section: 'sessions', ref: 'sess-full-id', rank: 1 },
    ]);
    expect(calls[0]).toHaveLength(4);
  });

  it('hands the task key to context.brief even when the brief never names it', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');
    const asked: { for: string; initiative: string }[] = [];

    await spawnCli(bin, TASK_ARGS, 'Synthetic brief', {
      contextBrief: async (args) => {
        asked.push(args);
        return served;
      },
      hitLog: async () => null,
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.for).toContain('TP-1');
    expect(asked[0]?.initiative).toBe('synthetic');
  });

  it('sends the brief unchanged and names the reason when context.brief throws', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');

    const run = await spawnCli(bin, TASK_ARGS, 'Synthetic brief', {
      contextBrief: async () => {
        throw new Error('index unavailable');
      },
    });

    expect(recordedStdin()).toBe('Synthetic brief');
    expect(run.stderr).toBe('context.brief skipped: index unavailable\n');
  });

  it('refuses a --task that is not <initiative>/<ID>', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');
    const args = ['synthetic-coord', 'synthetic-coordinator', '--brief-stdin', '--task', 'TP-1'];

    await expect(spawnCli(bin, args)).rejects.toThrow(/--task must be/);
  });

  it('sends the brief unchanged and names the reason on stderr when context.brief degrades', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');
    const { calls, hitLog } = recorder();
    const degraded = {
      text: '',
      refs: [],
      bytes: 0,
      degraded: [{ source: 'workspace', reason: 'timeout', message: 'over the 2000 ms brief deadline' }],
    };

    const run = await spawnCli(bin, TASK_ARGS, 'Synthetic brief', { contextBrief: async () => degraded, hitLog });

    expect(recordedStdin()).toBe('Synthetic brief');
    expect(run.stderr).toBe('context.brief skipped: workspace timeout\n');
    expect(calls).toEqual([]);
  });

  it('sends the brief unchanged and logs nothing without --task', async () => {
    const bin = fakeAgentChat('Spawned synthetic-coord');
    const { calls, hitLog } = recorder();

    const run = await spawnCli(bin, TASK_ARGS.slice(0, 3), 'Synthetic brief', {
      contextBrief: async () => served,
      hitLog,
    });

    expect(recordedStdin()).toBe('Synthetic brief');
    expect(run.stderr).toBe('');
    expect(calls).toEqual([]);
  });
});
