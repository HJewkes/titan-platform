import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as clackPrompts from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepPaths } from './steps-deps.js';
import { getSupervisor } from './supervision.js';
import { runUninstall } from './uninstall.js';

const SKILL_PROMPT = 'Remove the active-work skill from ~/.claude/skills/?';
const COMMAND_PROMPT = 'Remove the /aw-prompt command from ~/.claude/commands/?';
const DAEMON_PROMPT = 'Stop the daemon?';
const MCP_PROMPT = 'Unregister MCP from Claude Code?';

// The host's own supervisor (systemd, launchd or none) decides this prompt and step.
const supervisor = getSupervisor();
const SUPERVISION_PROMPT = supervisor?.uninstallPrompt ?? '';
const SUPERVISION_PROMPTS = supervisor ? [SUPERVISION_PROMPT] : [];
const SUPERVISION_STEPS = supervisor ? ['install-supervision'] : [];
const STEP_NAMES = [
  'install-skill',
  'install-command',
  ...SUPERVISION_STEPS,
  'start-daemon',
  'register-mcp',
];
const PROMPTS = [SKILL_PROMPT, COMMAND_PROMPT, ...SUPERVISION_PROMPTS, DAEMON_PROMPT, MCP_PROMPT];

const temps: string[] = [];

/** A synthetic home, with the skill dir and command file present when asked. */
function makeHome(installed: boolean): StepPaths {
  const base = mkdtempSync(path.join(tmpdir(), 'aw-uninstall-test-'));
  temps.push(base);
  const homeDir = path.join(base, 'home');
  if (installed) {
    mkdirSync(path.join(homeDir, '.claude', 'skills', 'active-work'), { recursive: true });
    mkdirSync(path.join(homeDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(homeDir, '.claude', 'commands', 'aw-prompt.md'), 'synthetic');
  }
  return {
    activeRoot: path.join(base, 'active'),
    stateRoot: path.join(base, 'state'),
    configRoot: path.join(base, 'config'),
    homeDir,
  };
}

/** A spawn whose child is a real process that exits with `code`. */
function exitingSpawn(code: number) {
  return vi.fn<typeof nodeSpawn>(() =>
    nodeSpawn(process.execPath, ['-e', `process.exit(${code})`]),
  );
}

/** Answers each confirm prompt by its message; anything unlisted is a yes. */
function scriptedPrompts(answers: Partial<Record<string, boolean | 'cancel'>>) {
  const asked: Array<{ message: string; initialValue: boolean | undefined }> = [];
  const cancelled = Symbol('cancel');
  const confirm = vi.fn<typeof clackPrompts.confirm>(async (opts) => {
    asked.push({ message: opts.message, initialValue: opts.initialValue });
    const answer = answers[opts.message];
    return answer === 'cancel' ? cancelled : answer !== false;
  });
  const isCancel = (value: unknown): value is symbol => value === cancelled;
  return { prompts: { ...clackPrompts, confirm, isCancel }, asked };
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stepNamed(report: Awaited<ReturnType<typeof runUninstall>>, name: string) {
  return report.steps.find((step) => step.name === name);
}

describe('runUninstall', () => {
  it('runs every step without prompting when yes is set', async () => {
    const { prompts, asked } = scriptedPrompts({});
    const paths = makeHome(true);

    const report = await runUninstall({ prompts, yes: true, paths, spawn: exitingSpawn(0) });

    expect(asked).toEqual([]);
    expect(report.activeRootPreservedAt).toBe(paths.activeRoot);
    expect(report.steps.map((s) => s.name)).toEqual(STEP_NAMES);
    expect(stepNamed(report, 'install-skill')).toEqual({
      name: 'install-skill',
      done: true,
      message: expect.stringContaining('Removed skill'),
    });
    expect(stepNamed(report, 'install-command')).toEqual({
      name: 'install-command',
      done: true,
      message: expect.stringContaining('Removed /aw-prompt'),
    });
    expect(stepNamed(report, 'start-daemon')).toEqual({
      name: 'start-daemon',
      done: true,
      message: 'Daemon stopped',
    });
    expect(stepNamed(report, 'register-mcp')).toEqual({
      name: 'register-mcp',
      done: true,
      message: 'Unregistered MCP server from Claude Code',
    });
  });

  it('asks the prompts in order, each defaulting to yes', async () => {
    const { prompts, asked } = scriptedPrompts({});

    await runUninstall({ prompts, paths: makeHome(true), spawn: exitingSpawn(0) });

    expect(asked).toEqual(PROMPTS.map((message) => ({ message, initialValue: true })));
  });

  it.each(PROMPTS)('skips only the step behind the declined prompt: %s', async (prompt) => {
    const { prompts } = scriptedPrompts({ [prompt]: false });

    const report = await runUninstall({ prompts, paths: makeHome(true), spawn: exitingSpawn(0) });

    const skipped = report.steps.filter((s) => s.message === 'Skipped');
    expect(report.steps.map((s) => s.name)).toEqual(STEP_NAMES);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toEqual({
      name: STEP_NAMES[PROMPTS.indexOf(prompt)],
      done: false,
      message: 'Skipped',
    });
  });

  it('treats a cancelled prompt as a skip', async () => {
    const { prompts } = scriptedPrompts({ [DAEMON_PROMPT]: 'cancel' });

    const report = await runUninstall({ prompts, paths: makeHome(true), spawn: exitingSpawn(0) });

    expect(stepNamed(report, 'start-daemon')).toEqual({
      name: 'start-daemon',
      done: false,
      message: 'Skipped',
    });
  });

  it('omits the supervision step and prompt on a platform with no supervisor', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { prompts, asked } = scriptedPrompts({});
    try {
      const report = await runUninstall({ prompts, paths: makeHome(true), spawn: exitingSpawn(0) });

      expect(asked.map((a) => a.message)).toEqual([
        SKILL_PROMPT,
        COMMAND_PROMPT,
        DAEMON_PROMPT,
        MCP_PROMPT,
      ]);
      expect(report.steps.map((s) => s.name)).toEqual([
        'install-skill',
        'install-command',
        'start-daemon',
        'register-mcp',
      ]);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });

  it('reports a missing skill and a failing daemon stop without error fields', async () => {
    const { prompts } = scriptedPrompts({});
    const paths = makeHome(false);

    const report = await runUninstall({ prompts, paths, spawn: exitingSpawn(3) });

    expect(stepNamed(report, 'install-skill')).toEqual({
      name: 'install-skill',
      done: false,
      message: `Skill not present at ${path.join(
        paths.homeDir,
        '.claude',
        'skills',
        'active-work',
      )}`,
    });
    expect(stepNamed(report, 'start-daemon')).toEqual({
      name: 'start-daemon',
      done: false,
      message: 'Daemon stop exited 3',
    });
  });

  it('carries a failed step as an error and no message', async () => {
    const { prompts } = scriptedPrompts({});
    const paths = makeHome(false);
    mkdirSync(paths.homeDir, { recursive: true });
    writeFileSync(path.join(paths.homeDir, '.claude'), 'not a directory');

    const report = await runUninstall({ prompts, paths, spawn: exitingSpawn(0) });

    expect(stepNamed(report, 'install-skill')).toEqual({
      name: 'install-skill',
      done: false,
      error: expect.stringContaining('ENOTDIR'),
    });
  });
});
