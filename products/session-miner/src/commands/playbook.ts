import {
  curate,
  MemoryVectors,
  recall,
  reflectSession,
  scorePlaybook,
  staleBullets,
  type PlaybookDelta,
  type PlaybookStore,
  type ScoredBullet,
  type SemanticOptions,
} from "@titan-design/memory";
import { defineCommand, EXIT } from "@titan-design/registry";
import { sessionRef } from "@titan-design/session-read";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { DIARY_TABLES, PLAYBOOK_TABLES, requireMinerTables } from "../miner-tables.js";
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

const AddArgs = z.object({
  content: z.string().min(1),
  category: z.string().default("general"),
  tags: z.array(z.string()).default([]),
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
      tags: { long: "--tag", description: "tag (repeatable)" },
      session: { long: "--session", description: "session id for provenance" },
      negative: { long: "--negative", description: "record as an anti-pattern" },
    },
  },
  async run(args, ctx) {
    const delta: PlaybookDelta = { type: "add", content: args.content, category: args.category, tags: args.tags, isNegative: args.negative };
    const report = curate(playbookFor(ctx, "playbook.add"), [delta], { provenance: provenanceFor(ctx, args.session) });
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
    const store = playbookFor(ctx, "playbook.recall");
    const semantic = await semanticFor(ctx, store);
    const result = await recall(store, args.query, { limit: args.limit, semantic });
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
  cli: { positional: ["session"] },
  async run(args, ctx) {
    requireMinerTables(ctx, "playbook.reflect", DIARY_TABLES);
    const diary = buildDiary(ctx.graph(), args.session);
    if (!diary) throw Object.assign(new Error(`no session ${args.session}`), { code: EXIT.NOINPUT });
    const rendered = renderDiary(diary);
    if (args.dryRun || !ctx.reflector) return { diary: rendered, outcome: diary.outcome, applied: false, added: [], reinforced: [] };
    const result = await reflectSession(
      { store: playbookFor(ctx, "playbook.reflect") },
      { sessionRef: diary.sessionRef, diary: rendered, byteOffset: diary.byteOffset },
      ctx.reflector,
    );
    for (const r of result.rejected) ctx.warnings.push(`reflector output rejected (iteration ${r.iteration}): ${r.reason}`);
    return { diary: rendered, outcome: diary.outcome, applied: true, added: result.report.added, reinforced: result.report.reinforced };
  },
});

interface StaleBulletView extends BulletView {
  lastEvidenceAt: string;
}

interface StatusResponse {
  total: number;
  byMaturity: Record<string, number>;
  blocked: number;
  top: BulletView[];
  stale: number;
  staleOldest: StaleBulletView[];
}

export const playbookStatus = defineCommand<Record<string, never>, StatusResponse, MinerContext>({
  name: "playbook.status",
  description: "How many rules the playbook holds, by maturity, with the highest-confidence few and the quietest stale ones",
  args: z.object({}),
  result: z.custom<StatusResponse>(),
  async run(_args, ctx) {
    const store = playbookFor(ctx, "playbook.status");
    const now = new Date();
    const scored = scorePlaybook(store, now);
    const stale = staleBullets(store, now);
    const staleOldest = [...stale]
      .sort((a, b) => a.lastEvidenceAt.localeCompare(b.lastEvidenceAt) || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((b) => ({ ...toView(b), lastEvidenceAt: b.lastEvidenceAt }));
    const byMaturity: Record<string, number> = {};
    for (const b of scored) byMaturity[b.maturity] = (byMaturity[b.maturity] ?? 0) + 1;
    const top = [...scored].sort((a, b) => b.effectiveScore - a.effectiveScore || a.id.localeCompare(b.id)).slice(0, 5);
    return { total: scored.length, byMaturity, blocked: store.blockedPatterns().length, top: top.map(toView), stale: stale.length, staleOldest };
  },
});

function provenanceFor(ctx: MinerContext, sessionId: string | undefined): { sessionRef: string; byteOffset?: number } | undefined {
  if (sessionId === undefined) return undefined;
  requireMinerTables(ctx, "playbook.add --session", DIARY_TABLES);
  const diary = buildDiary(ctx.graph(), sessionId);
  return diary ? { sessionRef: diary.sessionRef, byteOffset: diary.byteOffset } : { sessionRef: sessionRef(sessionId) };
}

/** Building the index embeds new bullets, so an embedder failure surfaces here and must degrade to keywords like a failed query would. */
async function semanticFor(ctx: MinerContext, store: PlaybookStore): Promise<SemanticOptions | undefined> {
  const embedder = ctx.embedder;
  if (!embedder) return undefined;
  try {
    const index = await new MemoryVectors(ctx.graph().db, embedder).index(store.list());
    return { embedder, index };
  } catch (err) {
    ctx.warnings.push(`memory-vector degraded: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function playbookFor(ctx: MinerContext, command: string): PlaybookStore {
  requireMinerTables(ctx, command, PLAYBOOK_TABLES);
  return ctx.playbook();
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
