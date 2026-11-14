/**
 * The related-context section of a spawn brief, rendered within a byte budget (TP-5453 P11a).
 *
 * `context.related` returns hits for a caller to render; this returns finished text, so the
 * broker keeps a reserve for it and nothing else. It always ranks with the agent's view,
 * because `/rpc` runs every caller as the owner and a client header is not authentication.
 */
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
});

const DegradedSchema = z.object({ source: z.string(), reason: z.string(), message: z.string() });

const ResultSchema = z.object({
  text: z.string(),
  refs: z.array(z.object({ ref: z.string(), source: z.literal('workspace') })),
  bytes: z.number(),
  // Why the text is short or empty. Never an error: a caller renders what it got.
  degraded: z.array(DegradedSchema),
});

type Args = z.infer<typeof ArgsSchema>;
type BriefResult = BriefBlock & { degraded: RelatedDegradation[] };

interface BriefDeps {
  activeRoot: string;
  hitLog?: HitLogWriter;
  dbPath?: string;
  ensureFresh?: EnsureFresh;
}

async function logServed(
  args: Args,
  related: RelatedResult,
  block: BriefBlock,
  hitLog: HitLogWriter,
): Promise<string | null> {
  if (args.trigger === undefined || block.refs.length === 0) return null;
  const served = new Set(block.refs.map((entry) => entry.ref));
  const context = { ts: nowIso(), slug: args.initiative ?? '', trigger: args.trigger, query: args.for };
  return hitLog(servedHitEntries(related.hits.filter((hit) => served.has(hit.ref)), context));
}

/** The command's body, with the index and hit log injectable so tests never touch the live ones. */
export async function runBrief(args: Args, deps: BriefDeps): Promise<BriefResult> {
  const related = await runRelated(
    {
      for: args.for,
      limit: BRIEF_WORKSPACE_IDS,
      classes: briefClasses(),
      ...(args.initiative !== undefined ? { initiative: args.initiative } : {}),
    },
    deps,
  );
  const block = renderBriefBlock({
    hits: related.hits,
    degraded: related.degraded,
    activeRoot: deps.activeRoot,
    budgetBytes: args.budgetBytes ?? BRIEF_DEFAULT_BYTES,
    ...(args.initiative !== undefined ? { initiative: args.initiative } : {}),
  });
  const failure = await logServed(args, related, block, deps.hitLog ?? fileHitLog());
  const degraded = [...related.degraded];
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
    },
    usage: 'context brief --for <text> [--initiative <slug>] [--budget-bytes 2600] [--trigger spawn]',
  },
  async run(args, ctx) {
    return runBrief(args, { activeRoot: ctx.activeRoot });
  },
});
