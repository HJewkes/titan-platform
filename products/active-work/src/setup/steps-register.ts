/** Setup steps that register the MCP server with Claude Code and the agent-chat lifecycle hooks. */
import nodePath from 'node:path';
import type { spawn as nodeSpawn } from 'node:child_process';
import { errorCode, isObjectLike } from '@titan-design/rpc-protocol/narrow';
import { errorText, toError } from './errors.js';
import {
  resolveDeps,
  STEP_AGENT_CHAT_HOOKS,
  STEP_MCP,
  type SetupDeps,
  type StepResult,
} from './steps-deps.js';

/** Spawn a process and capture its exit code + stderr. */
export function runOnce(
  spawn: typeof nodeSpawn,
  cmd: string,
  args: string[],
): Promise<{ code: number | null; stderr: string; spawnError?: Error }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ code: null, stderr, spawnError: err });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        resolve({ code, stderr });
      });
    } catch (err) {
      settled = true;
      resolve({ code: null, stderr, spawnError: toError(err) });
    }
  });
}

const MCP_FALLBACK_SNIPPET = `{
  "active-work": {
    "command": "active-work",
    "args": ["mcp", "serve", "--stdio"]
  }
}`;

export async function stepRegisterMcp(deps: SetupDeps = {}): Promise<StepResult> {
  const { spawn } = resolveDeps(deps);
  const result = await runOnce(spawn, 'claude', [
    'mcp',
    'add',
    '--user',
    '@hjewkes/active-work',
    '--',
    'active-work',
    'mcp',
    'serve',
    '--stdio',
  ]);
  if (result.spawnError && errorCode(result.spawnError) === 'ENOENT') {
    return {
      ok: true,
      name: STEP_MCP,
      done: false,
      message:
        '`claude` CLI not found. Add this to ~/.claude.json mcpServers section:\n' +
        MCP_FALLBACK_SNIPPET,
    };
  }
  if (result.spawnError) {
    return {
      ok: true,
      name: STEP_MCP,
      done: false,
      message: `MCP registration skipped: ${result.spawnError.message}`,
    };
  }
  if (result.code === 0) {
    return {
      ok: true,
      name: STEP_MCP,
      done: true,
      message: 'Registered MCP server with Claude Code',
    };
  }
  return {
    ok: true,
    name: STEP_MCP,
    done: false,
    message:
      `claude mcp add exited with code ${result.code ?? 'null'}. ` +
      'If already registered, this is safe. Otherwise add manually:\n' +
      MCP_FALLBACK_SNIPPET,
  };
}

/** The two commands this build registers into agent-chat's on_spawn/on_complete hooks (AW-99/AW-100). */
const AGENT_CHAT_HOOK_COMMANDS: Record<'on_spawn' | 'on_complete', string> = {
  on_spawn: 'active-work hooks agent-chat-spawn',
  on_complete: 'active-work hooks agent-chat-complete',
};

/** Throws on a value that is no list, so the step fails rather than rewriting another tool's file. */
function registeredHooks(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  throw new TypeError(`Expected a list of hook commands, found ${typeof value}`);
}

/**
 * `~/.agent-chat/hooks.json` — outside this build's control, so a missing
 * home directory has to degrade gracefully.
 */
function agentChatHooksPath(agentChatHome: string): string {
  return nodePath.join(agentChatHome, 'hooks.json');
}

/**
 * Merges this build's on_spawn/on_complete commands into agent-chat's generic
 * lifecycle hooks (CC-71) — additive only. An existing `hooks.json` keeps
 * every entry another tool registered; re-running this step is a no-op once
 * both commands are present, since it checks membership rather than
 * appending unconditionally. No `~/.agent-chat` directory at all means
 * agent-chat isn't installed on this machine, which is a normal skip, not an
 * error — this build must not be what creates agent-chat's home directory.
 */
export async function stepRegisterAgentChatHooks(deps: SetupDeps = {}): Promise<StepResult> {
  const { fs, agentChatHome } = resolveDeps(deps);
  const hooksPath = agentChatHooksPath(agentChatHome);

  try {
    await fs.stat(agentChatHome);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return {
        ok: true,
        name: STEP_AGENT_CHAT_HOOKS,
        done: false,
        message: `agent-chat not found at ${agentChatHome} — skipped`,
      };
    }
    return { ok: false, name: STEP_AGENT_CHAT_HOOKS, error: errorText(err) };
  }

  try {
    let config: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(hooksPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isObjectLike(parsed)) config = parsed;
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        return {
          ok: false,
          name: STEP_AGENT_CHAT_HOOKS,
          error: `${hooksPath} exists but is not valid JSON: ${errorText(err)}`,
        };
      }
    }

    let changed = false;
    for (const event of ['on_spawn', 'on_complete'] as const) {
      const command = AGENT_CHAT_HOOK_COMMANDS[event];
      const existing = registeredHooks(config[event]);
      if (!existing.includes(command)) {
        config[event] = [...existing, command];
        changed = true;
      }
    }

    if (!changed) {
      return {
        ok: true,
        name: STEP_AGENT_CHAT_HOOKS,
        done: false,
        message: `Already registered in ${hooksPath}`,
      };
    }

    await fs.writeFile(hooksPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return {
      ok: true,
      name: STEP_AGENT_CHAT_HOOKS,
      done: true,
      message: `Registered on_spawn/on_complete hooks in ${hooksPath}`,
    };
  } catch (err) {
    return { ok: false, name: STEP_AGENT_CHAT_HOOKS, error: errorText(err) };
  }
}
