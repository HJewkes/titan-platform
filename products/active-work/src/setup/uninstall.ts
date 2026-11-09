/** `active-work uninstall`: removes what setup installed and leaves the active root in place. */
import nodePath from 'node:path';
import type * as clackPrompts from '@clack/prompts';
import { errorCode } from '@titan-design/rpc-protocol/narrow';
import { errorText } from './errors.js';
import { STEP_SUPERVISION } from './supervision-systemd.js';
import { getSupervisor } from './supervision.js';
import {
  pathExists,
  resolveDeps,
  STEP_COMMAND,
  STEP_DAEMON,
  STEP_MCP,
  STEP_SKILL,
  type SetupDeps,
  type StepResult,
} from './steps-deps.js';
import { runOnce } from './steps-register.js';

export interface UninstallReport {
  steps: Array<{ name: string; done: boolean; message?: string; error?: string }>;
  activeRootPreservedAt: string;
}

async function confirmStep(
  prompts: typeof clackPrompts,
  yes: boolean,
  message: string,
  initial = true,
): Promise<boolean> {
  if (yes) return true;
  const answer = await prompts.confirm({ message, initialValue: initial });
  if (prompts.isCancel(answer)) return false;
  return answer === true;
}

export async function uninstallSkill(deps: SetupDeps = {}): Promise<StepResult> {
  const { fs, paths } = resolveDeps(deps);
  const target = nodePath.join(paths.homeDir, '.claude', 'skills', 'active-work');
  try {
    if (!(await pathExists(fs, target))) {
      return {
        ok: true,
        name: STEP_SKILL,
        done: false,
        message: `Skill not present at ${target}`,
      };
    }
    await fs.rm(target, { recursive: true, force: true });
    return {
      ok: true,
      name: STEP_SKILL,
      done: true,
      message: `Removed skill from ${target}`,
    };
  } catch (err) {
    return { ok: false, name: STEP_SKILL, error: errorText(err) };
  }
}

export async function uninstallCommand(deps: SetupDeps = {}): Promise<StepResult> {
  const { fs, paths } = resolveDeps(deps);
  const target = nodePath.join(paths.homeDir, '.claude', 'commands', 'aw-prompt.md');
  try {
    if (!(await pathExists(fs, target))) {
      return {
        ok: true,
        name: STEP_COMMAND,
        done: false,
        message: `Command not present at ${target}`,
      };
    }
    await fs.rm(target, { force: true });
    return {
      ok: true,
      name: STEP_COMMAND,
      done: true,
      message: `Removed /aw-prompt command from ${target}`,
    };
  } catch (err) {
    return { ok: false, name: STEP_COMMAND, error: errorText(err) };
  }
}

export async function uninstallStopDaemon(deps: SetupDeps = {}): Promise<StepResult> {
  const { spawn, cliEntry } = resolveDeps(deps);
  const result = await runOnce(spawn, process.execPath, [cliEntry, 'mcp', 'stop']);
  if (result.spawnError) {
    return {
      ok: true,
      name: STEP_DAEMON,
      done: false,
      message: `Daemon stop skipped: ${result.spawnError.message}`,
    };
  }
  return {
    ok: true,
    name: STEP_DAEMON,
    done: result.code === 0,
    message: result.code === 0 ? 'Daemon stopped' : `Daemon stop exited ${result.code ?? 'null'}`,
  };
}

export async function uninstallMcp(deps: SetupDeps = {}): Promise<StepResult> {
  const { spawn } = resolveDeps(deps);
  const result = await runOnce(spawn, 'claude', [
    'mcp',
    'remove',
    '--user',
    '@hjewkes/active-work',
  ]);
  if (result.spawnError && errorCode(result.spawnError) === 'ENOENT') {
    return {
      ok: true,
      name: STEP_MCP,
      done: false,
      message: '`claude` CLI not found. Remove the entry manually from ~/.claude.json',
    };
  }
  if (result.spawnError) {
    return {
      ok: true,
      name: STEP_MCP,
      done: false,
      message: `MCP unregister skipped: ${result.spawnError.message}`,
    };
  }
  return {
    ok: true,
    name: STEP_MCP,
    done: result.code === 0,
    message:
      result.code === 0
        ? 'Unregistered MCP server from Claude Code'
        : `claude mcp remove exited with code ${result.code ?? 'null'}`,
  };
}

export async function runUninstall(deps: SetupDeps = {}): Promise<UninstallReport> {
  const resolved = resolveDeps(deps);
  const steps: UninstallReport['steps'] = [];

  const wantSkill = await confirmStep(
    resolved.prompts,
    resolved.yes,
    'Remove the active-work skill from ~/.claude/skills/?',
  );
  if (wantSkill) {
    const r = await uninstallSkill(deps);
    steps.push({
      name: r.name,
      done: r.ok ? r.done : false,
      ...(r.ok ? { message: r.message } : { error: r.error }),
    });
  } else {
    steps.push({ name: STEP_SKILL, done: false, message: 'Skipped' });
  }

  const wantCommand = await confirmStep(
    resolved.prompts,
    resolved.yes,
    'Remove the /aw-prompt command from ~/.claude/commands/?',
  );
  if (wantCommand) {
    const r = await uninstallCommand(deps);
    steps.push({
      name: r.name,
      done: r.ok ? r.done : false,
      ...(r.ok ? { message: r.message } : { error: r.error }),
    });
  } else {
    steps.push({ name: STEP_COMMAND, done: false, message: 'Skipped' });
  }

  const supervisor = getSupervisor();
  if (supervisor) {
    const wantSupervision = await confirmStep(
      resolved.prompts,
      resolved.yes,
      supervisor.uninstallPrompt,
    );
    if (wantSupervision) {
      const r = await supervisor.uninstall(deps);
      steps.push({
        name: r.name,
        done: r.ok ? r.done : false,
        ...(r.ok ? { message: r.message } : { error: r.error }),
      });
    } else {
      steps.push({ name: STEP_SUPERVISION, done: false, message: 'Skipped' });
    }
  }

  const wantDaemon = await confirmStep(resolved.prompts, resolved.yes, 'Stop the daemon?');
  if (wantDaemon) {
    const r = await uninstallStopDaemon(deps);
    steps.push({
      name: r.name,
      done: r.ok ? r.done : false,
      ...(r.ok ? { message: r.message } : { error: r.error }),
    });
  } else {
    steps.push({ name: STEP_DAEMON, done: false, message: 'Skipped' });
  }

  const wantMcp = await confirmStep(
    resolved.prompts,
    resolved.yes,
    'Unregister MCP from Claude Code?',
  );
  if (wantMcp) {
    const r = await uninstallMcp(deps);
    steps.push({
      name: r.name,
      done: r.ok ? r.done : false,
      ...(r.ok ? { message: r.message } : { error: r.error }),
    });
  } else {
    steps.push({ name: STEP_MCP, done: false, message: 'Skipped' });
  }

  return {
    steps,
    activeRootPreservedAt: resolved.paths.activeRoot,
  };
}
