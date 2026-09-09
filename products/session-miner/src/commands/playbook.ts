import { curate, recall, reflectSession, scorePlaybook, type PlaybookDelta, type ScoredBullet } from "@titan-design/memory";
import { defineCommand, EXIT } from "@titan-design/registry";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { buildDiary, renderDiary, type SessionDiary } from "../playbook/diary.js";

export interface BulletView {
  id: string;
  content: string;
  category: string;
  tags: string[];
  maturity: string;
  effectiveScore: number;
  helpfulCount: number;
  harmfulCount: number;
}

/**
 * The registry renders any non-boolean option as a single `<value>` flag, so an
 * array field has to accept the CLI's comma-separated form as well as the real
 * array that MCP and HTTP callers send.
 */
const tagList = z
  .union([z.array(z.string()), z.string()])
  .default([])
  .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((t) => t.trim()).filter((t) => t.length > 0));

const AddArgs = z.object({
  content: z.string().min(1),
  category: z.string().default("general"),
  tags: tagList,
  session: z.string().optional().describe("session id this rule was learned in"),
  negative: z.boolean().default(false),
});

/** The zero-LLM path: whoever just learned the thing writes it down. */
export const playbookAdd = defineCommand<z.infer<typeof AddArgs>, { report: ReturnType<typeof curate> }, MinerContext>({
  name: "playbook.add",
  description: "Add a rule to the playbook, curated deterministically against what is already there",
  args: AddArgs,
  result: z.custom<{ report: ReturnType<typeof curate> }>(),
  cli: {
    positional: ["content"],
    options: {
      category: { long: "--category", description: "grouping label" },
      tags: { long: "--tag", description: "comma-separated tags" },
      session: { long: "--session", description: "session id for provenance" },
      negative: { long: "--negative", description: "record as an anti-pattern" },
    },
  },
  async run(args, ctx) {
    const delta: PlaybookDelta = { type: "add", content: args.content, category: args.category, tags: args.tags, isNegative: args.negative };
    const report = curate(ctx.playbook(), [delta], { provenance: provenanceFor(ctx, args.session) });
    return { report };
  },
});

const RecallArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(10),
});

export const playbookRecall = defineCommand<z.infer<typeof RecallArgs>, { bullets: BulletView[]; antiPatterns: BulletView[]; deprecatedWarnings: BulletView[] }, MinerContext>({
  name: "playbook.recall",
  description: "What the playbook says about a topic, ranked by relevance times confidence",
  args: RecallArgs,
  result: z.custom<{ bullets: BulletView[]; antiPatterns: BulletView[]; deprecatedWarnings: BulletView[] }>(),
  cli: { positional: ["query"], options: { limit: { long: "--limit", short: "-n", description: "max bullets" } } },
  async run(args, ctx) {
    const result = await recall(ctx.playbook(), args.query, { limit: args.limit });
    for (const d of result.degraded) ctx.warnings.push(`${d.retriever} degraded: ${d.message}`);
    return {
      bullets: result.bullets.map(toView),
      antiPatterns: result.antiPatterns.map(toView),
      deprecatedWarnings: result.deprecatedWarnings.map(toView),
    };
  },
});

const ReflectArgs = z.object({
  session: z.string().min(1),
  dryRun: z.boolean().default(true).describe("render the diary without proposing any rules"),
});

export interface ReflectResponse {
  diary: string;
  outcome: SessionDiary["outcome"];
  applied: boolean;
  added: string[];
  reinforced: string[];
}

/**
 * Reflection needs a Reflector, which is the one stage that may call a model.
 * The miner does not ship one, so the default is the deterministic half: build
 * the diary and hand it back for an agent to read and turn into `playbook.add`
 * calls itself.
 */
export const playbookReflect = defineCommand<z.infer<typeof ReflectArgs>, ReflectResponse, MinerContext>({
  name: "playbook.reflect",
  description: "Build a session's diary from its subgraph, with graph-derived outcome labels",
  args: ReflectArgs,
  result: z.custom<ReflectResponse>(),
  cli: { positional: ["session"], options: { dryRun: { long: "--dry-run", description: "render only (default)" } } },
  async run(args, ctx) {
    const diary = buildDiary(ctx.graph(), args.session);
    if (!diary) throw Object.assign(new Error(`no session ${args.session}`), { code: EXIT.NOINPUT });
    const rendered = renderDiary(diary);
    if (args.dryRun || !ctx.reflector) return { diary: rendered, outcome: diary.outcome, applied: false, added: [], reinforced: [] };
    const result = await reflectSession(
      { store: ctx.playbook() },
      { sessionRef: diary.sessionRef, diary: rendered, byteOffset: diary.byteOffset },
      ctx.reflector,
    );
    for (const r of result.rejected) ctx.warnings.push(`reflector output rejected (iteration ${r.iteration}): ${r.reason}`);
    return { diary: rendered, outcome: diary.outcome, applied: true, added: result.report.added, reinforced: result.report.reinforced };
  },
});

export const playbookStatus = defineCommand<Record<string, never>, { total: number; byMaturity: Record<string, number>; blocked: number; top: BulletView[] }, MinerContext>({
  name: "playbook.status",
  description: "How many rules the playbook holds, by maturity, with the highest-confidence few",
  args: z.object({}),
  result: z.custom<{ total: number; byMaturity: Record<string, number>; blocked: number; top: BulletView[] }>(),
  async run(_args, ctx) {
    const store = ctx.playbook();
    const scored = scorePlaybook(store, new Date());
    const byMaturity: Record<string, number> = {};
    for (const b of scored) byMaturity[b.maturity] = (byMaturity[b.maturity] ?? 0) + 1;
    const top = [...scored].sort((a, b) => b.effectiveScore - a.effectiveScore || a.id.localeCompare(b.id)).slice(0, 5);
    return { total: scored.length, byMaturity, blocked: store.blockedPatterns().length, top: top.map(toView) };
  },
});

function provenanceFor(ctx: MinerContext, sessionId: string | undefined): { sessionRef: string; byteOffset?: number } | undefined {
  if (sessionId === undefined) return undefined;
  const diary = buildDiary(ctx.graph(), sessionId);
  return diary ? { sessionRef: diary.sessionRef, byteOffset: diary.byteOffset } : { sessionRef: `session:${sessionId}` };
}

function toView(bullet: ScoredBullet): BulletView {
  return {
    id: bullet.id,
    content: bullet.content,
    category: bullet.category,
    tags: bullet.tags,
    maturity: bullet.maturity,
    effectiveScore: bullet.effectiveScore,
    helpfulCount: bullet.helpfulCount,
    harmfulCount: bullet.harmfulCount,
  };
}
