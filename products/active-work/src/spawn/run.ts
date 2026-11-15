import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { DispatchError, spawnAsCaller } from '@titan-design/agent-dispatch';
import { ConfigError, EXIT } from '../errors.js';
import { runBrief } from '../commands/context-brief.js';
import { fileHitLog, servedHitEntries, type HitLogWriter } from '../search/hit-log.js';
import { nowIso } from '../utils/today.js';
import { getActiveRoot } from '../utils/paths.js';

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
  task?: string;
}

export interface SpawnDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => Promise<void>;
  /** Injectable so tests never touch the live index; defaults to the context.brief body. */
  contextBrief?: (args: { for: string; initiative: string }) => Promise<TaskBrief>;
  hitLog?: HitLogWriter;
}

interface TaskBrief {
  text: string;
  refs: { ref: string; source: string }[];
  degraded: { source: string; reason: string }[];
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

const TASK_CONTEXT_HEADING = '## Retrieved context';

const defaultContextBrief: NonNullable<SpawnDeps['contextBrief']> = (args) =>
  runBrief(args, { activeRoot: getActiveRoot() });

/** Each rendered ref once, under the section (workspace, code or sessions) it was rendered in. */
async function logServedRefs(task: string, query: string, block: TaskBrief, deps: SpawnDeps): Promise<void> {
  const ts = nowIso();
  const slug = task.split('/')[0] ?? '';
  const sections = [...new Set(block.refs.map((entry) => entry.source))];
  const entries = sections.flatMap((section) => {
    const refs = new Set(block.refs.filter((entry) => entry.source === section).map((entry) => entry.ref));
    const hits = [...refs].map((ref) => ({ ref, byteOffset: null, byteLength: null }));
    return servedHitEntries(hits, { ts, slug, trigger: 'spawn', query, task, section });
  });
  const failure = await (deps.hitLog ?? fileHitLog())(entries);
  if (failure !== null) deps.stderr(`context.brief hit log failed: ${failure}\n`);
}

/** The brief with the task's context block appended; unchanged, with one stderr line, when the block is unavailable. */
async function withTaskContext(brief: string, task: string, deps: SpawnDeps): Promise<string> {
  const [initiative = '', id = ''] = task.split('/');
  let block: TaskBrief;
  try {
    // The key rides in the text because context.brief reads a task's done_when and owned files from keys it finds there.
    block = await (deps.contextBrief ?? defaultContextBrief)({ for: `${brief}\n\n${id}`, initiative });
  } catch (err) {
    deps.stderr(`context.brief skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    return brief;
  }
  if (block.text === '') {
    const why = block.degraded.map((entry) => `${entry.source} ${entry.reason}`).join(', ') || 'nothing ranked';
    deps.stderr(`context.brief skipped: ${why}\n`);
    return brief;
  }
  await logServedRefs(task, brief, block, deps);
  return `${brief}\n\n${TASK_CONTEXT_HEADING}\n\n${block.text}\n`;
}

/** Prints agent-chat's lines verbatim; a refusal prints its text (with the account readings) and returns 1. */
export async function runSpawn(plan: SpawnPlan, deps: SpawnDeps): Promise<number> {
  const agentChatBinPath = findAgentChat(deps.env);
  const read = await readBrief(plan.brief, deps);
  const brief = plan.task === undefined ? read : await withTaskContext(read, plan.task, deps);
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
