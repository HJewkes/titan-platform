import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { DispatchError, spawnAsCaller } from '@titan-design/agent-dispatch';
import { ConfigError, EXIT } from '../errors.js';

export type BriefSource = { kind: 'file'; path: string } | { kind: 'stdin' };

/** The CLI returns once the broker has accepted or refused; a cold worktree setup is the slow case. */
const SPAWN_TIMEOUT_MS = 120_000;

export interface SpawnPlan {
  name: string;
  profile: string;
  brief: BriefSource;
  cwd: string;
  account: string;
  host?: string;
  briefing?: string;
  surface?: string;
  remoteControl?: true;
}

export interface SpawnDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => Promise<void>;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function processSpawnDeps(exit: (code: number) => Promise<void>): SpawnDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    readStdin: () => readAll(process.stdin),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    exit,
  };
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `AGENT_CHAT_BIN` wins; otherwise the shell's own PATH, since this runs from a terminal or an agent's Bash, never a daemon. */
function findAgentChat(env: NodeJS.ProcessEnv): string {
  if (env.AGENT_CHAT_BIN) return env.AGENT_CHAT_BIN;
  const found = (env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .map((dir) => join(dir, 'agent-chat'))
    .find(isExecutableFile);
  if (!found) throw new ConfigError('agent-chat is not on PATH; install it or set AGENT_CHAT_BIN');
  return found;
}

async function readBrief(source: BriefSource, deps: SpawnDeps): Promise<string> {
  if (source.kind === 'stdin') return deps.readStdin();
  return readFileSync(resolve(deps.cwd, source.path), 'utf8');
}

/** Prints agent-chat's lines verbatim; a refusal prints its text (with the account readings) and returns 1. */
export async function runSpawn(plan: SpawnPlan, deps: SpawnDeps): Promise<number> {
  const agentChatBinPath = findAgentChat(deps.env);
  const brief = await readBrief(plan.brief, deps);
  try {
    const result = await spawnAsCaller(
      {
        agentChatBinPath,
        name: plan.name,
        profile: plan.profile,
        brief,
        cwd: plan.cwd,
        briefing: plan.briefing,
        host: plan.host,
        account: plan.account,
        surface: plan.surface,
        remoteControl: plan.remoteControl,
      },
      SPAWN_TIMEOUT_MS,
    );
    for (const line of result.lines) deps.stdout(line + '\n');
    return EXIT.OK;
  } catch (err) {
    if (!(err instanceof DispatchError)) throw err;
    deps.stderr(err.message + '\n');
    return EXIT.GENERIC;
  }
}
