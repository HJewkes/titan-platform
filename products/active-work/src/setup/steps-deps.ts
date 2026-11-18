/**
 * Shared types, dependency resolution, step names and fs helpers for the
 * setup and uninstall steps.
 *
 * Each step is a small async function that accepts a `SetupDeps` bag
 * (filesystem, spawn, prompts, paths). Tests inject stubs; production
 * callers let everything default. Steps never throw on failure — they
 * return a tagged result so the orchestrator can short-circuit cleanly.
 */
import { promises as fsp, existsSync } from 'node:fs';
import nodePath from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as clackPrompts from '@clack/prompts';
import { errorCode } from '@titan-design/rpc-protocol/narrow';
import { getActiveRoot, getStateRoot, getConfigRoot } from '../utils/paths.js';
import { STEP_SUPERVISION } from './supervision-systemd.js';

function findRepoRoot(): string {
  let cursor = nodePath.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(nodePath.join(cursor, 'package.json'))) return cursor;
    const parent = nodePath.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Fallback: two up from current file (covers source layout).
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export interface StepPaths {
  activeRoot: string;
  stateRoot: string;
  configRoot: string;
  homeDir: string;
}

export interface SetupDeps {
  fs?: typeof fsp;
  spawn?: typeof nodeSpawn;
  prompts?: typeof clackPrompts;
  paths?: StepPaths;
  /** When true, skip interactive prompts and assume yes. */
  yes?: boolean;
  /** When true, allow overwrite of existing user files. */
  update?: boolean;
  /** Optional override for repo root (where bundled skill lives). */
  repoRoot?: string;
  /** Optional override for the CLI entrypoint (for spawn calls). */
  cliEntry?: string;
  /**
   * Whether a supervisor already owns the daemon; null when the platform has
   * no integration. Defaults to probing launchctl/systemctl, so tests inject
   * it instead of reading the host's real supervision state.
   */
  supervisorActive?: () => Promise<{ kind: string; active: boolean } | null>;
}

interface StepOk {
  ok: true;
  name: string;
  done: boolean;
  message: string;
}

interface StepErr {
  ok: false;
  name: string;
  error: string;
}

export type StepResult = StepOk | StepErr;

/** Resolve every defaultable dep so each step has a complete bag. */
export function resolveDeps(deps: SetupDeps): Required<
  Omit<SetupDeps, 'yes' | 'update' | 'repoRoot' | 'cliEntry' | 'supervisorActive'>
> & {
  yes: boolean;
  update: boolean;
  repoRoot: string;
  cliEntry: string;
  agentChatHome: string;
} {
  const fs = deps.fs ?? fsp;
  const spawn = deps.spawn ?? nodeSpawn;
  const prompts = deps.prompts ?? clackPrompts;
  const homeDir = deps.paths?.homeDir ?? os.homedir();
  const paths: StepPaths = deps.paths ?? {
    activeRoot: getActiveRoot(),
    stateRoot: getStateRoot(),
    configRoot: getConfigRoot(),
    homeDir,
  };
  // `AGENT_CHAT_HOME` (matching agent-chat's own `home()` in `src/paths.ts`)
  // only overrides the default, real home directory — once a caller injects
  // `paths` (as every test does), it fully controls where agent-chat's home
  // resolves to, regardless of what's exported in the real shell.
  const agentChatHome = deps.paths
    ? nodePath.join(homeDir, '.agent-chat')
    : (process.env.AGENT_CHAT_HOME ?? nodePath.join(homeDir, '.agent-chat'));
  // The bundled skill lives at `<repoRoot>/skill`. Find it by walking up
  // from this module until we hit a directory containing `package.json`
  // — works both for source (`src/setup/steps.ts`) and bundled
  // (`dist/cli.js`) layouts.
  const repoRoot = deps.repoRoot ?? findRepoRoot();
  const cliEntry = deps.cliEntry ?? process.argv.at(1) ?? 'active-work';
  return {
    fs,
    spawn,
    prompts,
    paths,
    agentChatHome,
    yes: deps.yes ?? false,
    update: deps.update ?? false,
    repoRoot,
    cliEntry,
  };
}

export const STEP_CHECK_NODE = 'check-node';
export const STEP_CREATE_ACTIVE = 'create-active-root';
export const STEP_SCHEMA = 'write-schema-version';
export const STEP_CONFIG = 'write-config-stub';
export const STEP_SKILL = 'install-skill';
export const STEP_COMMAND = 'install-command';
export const STEP_MCP = 'register-mcp';
export const STEP_AGENT_CHAT_HOOKS = 'register-agent-chat-hooks';
export const STEP_DAEMON = 'start-daemon';
export const STEP_INGEST = 'ingestion';

export const STEP_NAMES = {
  CHECK_NODE: STEP_CHECK_NODE,
  CREATE_ACTIVE: STEP_CREATE_ACTIVE,
  SCHEMA: STEP_SCHEMA,
  CONFIG: STEP_CONFIG,
  SKILL: STEP_SKILL,
  COMMAND: STEP_COMMAND,
  MCP: STEP_MCP,
  AGENT_CHAT_HOOKS: STEP_AGENT_CHAT_HOOKS,
  SUPERVISION: STEP_SUPERVISION,
  DAEMON: STEP_DAEMON,
  INGEST: STEP_INGEST,
} as const;

export async function ensureDir(fs: typeof fsp, dir: string): Promise<{ created: boolean }> {
  try {
    const stat = await fs.stat(dir);
    if (stat.isDirectory()) return { created: false };
    throw new Error(`${dir} exists but is not a directory`);
  } catch (err) {
    const code = errorCode(err);
    if (code !== 'ENOENT') throw err;
  }
  await fs.mkdir(dir, { recursive: true });
  return { created: true };
}

export async function pathExists(fs: typeof fsp, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

export async function copyTree(fs: typeof fsp, src: string, dest: string): Promise<void> {
  // node:fs/promises has cp() in Node 22+, but a stubbed fs may omit it whatever its declared type says.
  const cp: unknown = fs.cp;
  if (typeof cp === 'function') {
    await fs.cp(src, dest, { recursive: true });
    return;
  }
  // Fallback: shallow copy of files only (test envs may stub fs).
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = nodePath.join(src, entry.name);
    const to = nodePath.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(fs, from, to);
    } else {
      await fs.copyFile(from, to);
    }
  }
}
