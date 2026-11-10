import { spawn } from 'node:child_process';
import resumeCommand from './commands/resume.js';
import { agentCaller } from './commands/_done-when-gate.js';
import { awaitChild } from './launcher-open.js';
import { buildResumeArgs, extractProfileFlag, NO_RC_FLAGS } from './launcher-args.js';
import { CONFIG_DIR_ENV, requireProfileDir } from './launcher-profile.js';
import { getActiveRoot } from './utils/paths.js';
import { formatError, EXIT } from './errors.js';
import { color } from './utils/color.js';
import { exitAfterFlush } from './utils/exit.js';
import type { CommandContext } from './registry/index.js';

/** Pin the config dir the transcript lives under; unset means claude's own default (~/.claude). */
function resumeEnv(base: NodeJS.ProcessEnv, configDir?: string): NodeJS.ProcessEnv {
  const env = { ...base };
  if (configDir) env[CONFIG_DIR_ENV] = configDir;
  else delete env[CONFIG_DIR_ENV];
  return env;
}

export function spawnClaudeResume(
  sessionId: string,
  cwd: string,
  remoteControl: boolean,
  configDir?: string,
  spawnFn: typeof spawn = spawn,
): Promise<number> {
  const child = spawnFn('claude', buildResumeArgs(sessionId, { remoteControl }), {
    cwd,
    stdio: 'inherit',
    env: resumeEnv(process.env, configDir),
  });
  return awaitChild(child, 'error: `claude` not found on PATH.\n');
}

/**
 * `aw resume <session_id>` — find the directory a session id belongs to
 * (active-work's own session log, then a direct match under
 * every Claude config dir's `projects`, profiles included) and launch `claude --resume` there, so the caller
 * doesn't need to already know or remember where the session ran.
 */
export async function runResume(argv: string[]): Promise<void> {
  const parsed = parseResumeArgs(argv);
  if (!parsed) {
    process.stderr.write(color.red('usage: aw resume <session_id> [--no-rc] [--profile <name>]\n'));
    return exitAfterFlush(EXIT.USAGE);
  }
  try {
    return exitAfterFlush(await resumeSession(parsed));
  } catch (err) {
    const { message, code } = formatError(err);
    process.stderr.write(color.red(`error: ${message}\n`));
    return exitAfterFlush(code);
  }
}

interface ResumeArgs {
  sessionId: string;
  remoteControl: boolean;
  profile?: string;
}

function parseResumeArgs(argv: string[]): ResumeArgs | null {
  const { profile, rest: tail, missingValue } = extractProfileFlag(argv.slice(3));
  const remoteControl = !tail.some((a) => NO_RC_FLAGS.includes(a));
  const rest = tail.filter((a) => !NO_RC_FLAGS.includes(a));
  const [sessionId] = rest;
  if (missingValue || rest.length !== 1 || sessionId.startsWith('-')) {
    return null;
  }
  return { sessionId, remoteControl, profile };
}

async function resumeSession({ sessionId, remoteControl, profile }: ResumeArgs): Promise<number> {
  const ctx: CommandContext = {
    activeRoot: getActiveRoot(),
    warnings: [],
    format: 'json',
    cwd: process.cwd(),
    caller: agentCaller(process.env),
  };
  const profileDir = profile ? requireProfileDir(profile) : undefined;
  const parsed = resumeCommand.args.parse({ session_id: sessionId });
  const resolved = await resumeCommand.run(parsed, ctx);
  const configDir = profileDir ?? resolved.configDir;
  process.stderr.write(
    color.dim(
      `Resuming ${sessionId} in ${resolved.cwd} (found via ${resolved.source}${configDir ? `, config dir ${configDir}` : ''}).\n`,
    ),
  );
  return spawnClaudeResume(sessionId, resolved.cwd, remoteControl, configDir);
}
