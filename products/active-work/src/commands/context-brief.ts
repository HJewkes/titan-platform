/**
 * The related-context section of a spawn brief, rendered within a byte budget (TP-5453 P11a).
 *
 * `context.related` returns hits for a caller to render; this returns finished text, so the
 * broker keeps a reserve for it and nothing else. It always ranks with the agent's view,
 * because `/rpc` runs every caller as the owner and a client header is not authentication.
 */
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import {
  BRIEF_DEFAULT_BYTES,
  BRIEF_MAX_BYTES,
  BRIEF_WORKSPACE_IDS,
  briefClasses,
  renderBriefBlock,
  type BriefBlock,
} from '../search/brief-block.js';
import { briefCode, defaultSleep, withCode, withDeadline, type BriefCode, type CodeDeps } from '../search/brief-code.js';
import { briefSessions, withSessions, type BriefSessions } from '../search/brief-sessions.js';
import { taskFiles } from '../search/brief-task-files.js';
import { fileHitLog, HIT_TRIGGERS, servedHitEntries, type HitLogWriter } from '../search/hit-log.js';
import type { RelatedDegradation, RelatedResult } from '../search/related.js';
import type { EnsureFresh } from '../session-index/freshness.js';
import { nowIso } from '../utils/today.js';
import { runRelated } from './context-related.js';

const ArgsSchema = z.object({
  for: z.string(),
  initiative: z.string().min(1).optional(),
  budgetBytes: z.number().int().positive().max(BRIEF_MAX_BYTES).optional(),
  // Only a caller that pastes the text into a prompt names one; a human query logs nothing.
  trigger: z.enum(HIT_TRIGGERS).optional(),
  // The spawn's checkout: named files' imports are read from it when codewatch has no snapshot.
  repoRoot: z.string().refine(path.isAbsolute, 'repoRoot must be an absolute path').optional(),
});

/** The whole verb's budget, under the broker's 2,500 ms timeout (CC-138). */
const BRIEF_DEADLINE_MS = 2000;

const DegradedSchema = z.object({ source: z.string(), reason: z.string(), message: z.string() });

const ResultSchema = z.object({
  text: z.string(),
  refs: z.array(z.object({ ref: z.string(), source: z.enum(['workspace', 'code', 'sessions']) })),
  bytes: z.number(),
  // Why the text is short or empty. Never an error: a caller renders what it got.
  degraded: z.array(DegradedSchema),
});

type Args = z.infer<typeof ArgsSchema>;
type BriefResult = BriefBlock & { degraded: RelatedDegradation[] };
type Workspace = Pick<RelatedResult, 'hits' | 'degraded'>;

interface BriefDeps {
  activeRoot: string;
  hitLog?: HitLogWriter;
  dbPath?: string;
  ensureFresh?: EnsureFresh;
  now?: Date;
  /** Codewatch transport and the clock every deadline here reads. */
  code?: Omit<CodeDeps, 'repoRoot'>;
}

async function logServed(
  args: Args,
  related: Workspace,
  block: BriefBlock,
  hitLog: HitLogWriter,
): Promise<string | null> {
  if (args.trigger === undefined || block.refs.length === 0) return null;
  const served = new Set(block.refs.map((entry) => entry.ref));
  const context = { ts: nowIso(), slug: args.initiative ?? '', trigger: args.trigger, query: args.for };
  return hitLog(servedHitEntries(related.hits.filter((hit) => served.has(hit.ref)), context));
}

function sessionsFor(args: Args, deps: BriefDeps): Promise<BriefSessions> {
  return briefSessions({
    text: args.for,
    activeRoot: deps.activeRoot,
    now: deps.now ?? new Date(),
    ...(deps.dbPath !== undefined ? { dbPath: deps.dbPath } : {}),
  });
}

async function codeFor(args: Args, deps: BriefDeps): Promise<BriefCode> {
  const initiative = args.initiative !== undefined ? { initiative: args.initiative } : {};
  const files = await taskFiles({ text: args.for, activeRoot: deps.activeRoot, ...initiative });
  const repoRoot = args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {};
  return briefCode(files, { ...deps.code, ...repoRoot });
}

function workspaceFor(args: Args, deps: BriefDeps): Promise<Workspace> {
  return runRelated(
    {
      for: args.for,
      limit: BRIEF_WORKSPACE_IDS,
      classes: briefClasses(),
      ...(args.initiative !== undefined ? { initiative: args.initiative } : {}),
    },
    deps,
  );
}

const lateSource = (source: string): RelatedDegradation => ({
  source,
  reason: 'timeout',
  message: `over the ${BRIEF_DEADLINE_MS} ms brief deadline`,
});

/** All three sources at once, each cut off at the shared deadline, so one slow source never holds the others. */
function gatherSources(args: Args, deps: BriefDeps): Promise<[Workspace, BriefCode, BriefSessions]> {
  const sleep = deps.code?.sleep ?? defaultSleep;
  const bounded = <T>(work: () => Promise<T>, late: () => T): Promise<T> =>
    withDeadline(work, BRIEF_DEADLINE_MS, sleep, late);
  return Promise.all([
    bounded(() => workspaceFor(args, deps), () => ({ hits: [], degraded: [lateSource('workspace')] })),
    bounded(() => codeFor(args, deps), () => ({ lines: [], refs: [], degraded: [lateSource('code')] })),
    bounded(() => sessionsFor(args, deps), () => ({ lines: [], refs: [], degraded: [lateSource('sessions')] })),
  ]);
}

/** The command's body, with the index and hit log injectable so tests never touch the live ones. */
export async function runBrief(args: Args, deps: BriefDeps): Promise<BriefResult> {
  const [related, code, sessions] = await gatherSources(args, deps);
  const budgetBytes = args.budgetBytes ?? BRIEF_DEFAULT_BYTES;
  const workspace = renderBriefBlock({
    hits: related.hits,
    degraded: related.degraded,
    activeRoot: deps.activeRoot,
    budgetBytes,
    ...(args.initiative !== undefined ? { initiative: args.initiative } : {}),
  });
  const block = withSessions(withCode(workspace, code, budgetBytes), sessions, budgetBytes);
  const failure = await logServed(args, related, block, deps.hitLog ?? fileHitLog());
  const degraded = [...related.degraded, ...code.degraded, ...sessions.degraded];
  if (failure !== null) degraded.push({ source: 'hit-log', reason: 'error', message: failure });
  return { ...block, degraded };
}

export default defineCommand<Args, z.infer<typeof ResultSchema>>({
  name: 'context.brief',
  description:
    'Render the related-context section of a spawn brief within a UTF-8 byte budget; always the agent view, and empty rather than failing when the index is unavailable',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      for: { long: '--for', description: 'The assignment text to brief (required)' },
      initiative: {
        long: '--initiative',
        description: 'Bias towards this initiative. A boost, never a filter.',
      },
      budgetBytes: {
        long: '--budget-bytes',
        description: `Most UTF-8 bytes of text (default ${BRIEF_DEFAULT_BYTES}, max ${BRIEF_MAX_BYTES})`,
      },
      trigger: {
        long: '--trigger',
        description: `Log the rendered refs as served, under this trigger (${HIT_TRIGGERS.join(', ')})`,
      },
      repoRoot: {
        long: '--repo-root',
        description: 'Absolute checkout to read named files from when codewatch has no snapshot',
      },
    },
    usage:
      'context brief --for <text> [--initiative <slug>] [--budget-bytes 2600] [--trigger spawn] [--repo-root <dir>]',
  },
  async run(args, ctx) {
    return runBrief(args, { activeRoot: ctx.activeRoot });
  },
});
