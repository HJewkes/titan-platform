import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { classifySession, type SessionClass } from "./classify-session.js";
import {
  readCompactions,
  readCostRows,
  readCoverage,
  readPriceTableVersion,
  readSessionContexts,
  type CompactionRow,
  type CostRow,
  type ReportWindow,
  type SessionContext,
} from "./cost-report-queries.js";
import { sessionInitiative } from "./initiative.js";

const count = z.number().int().nonnegative();
const bucketSchema = z.object({ key: z.string(), requests: count, sessions: count, costUsd: z.number() });
const wakePartSchema = bucketSchema.extend({ midLoopRequests: count, midLoopCostUsd: z.number() });
const cellSchema = z.object({ wakeCause: z.string(), gapBand: z.string(), requests: count, costUsd: z.number() });

export const TOKEN_CLASSES = ["input", "cache_read", "cache_write_5m", "cache_write_1h", "output"] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

export const costReportSchema = z.object({
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  priceTableVersion: z.number().int().nullable(),
  totals: z.object({ requests: count, sessions: count, costUsd: z.number(), unpricedRequests: count }),
  byTokenClass: z.array(z.object({ tokenClass: z.enum(TOKEN_CLASSES), tokens: count, costUsd: z.number() })),
  byAccount: z.array(bucketSchema),
  byModel: z.array(bucketSchema),
  byClass: z.array(bucketSchema),
  byRole: z.array(bucketSchema),
  byInitiative: z.array(bucketSchema),
  byContextBand: z.array(bucketSchema),
  byWakeCause: z.array(wakePartSchema.extend({ parts: z.array(wakePartSchema) })),
  wakeCauseByGapBand: z.array(cellSchema),
  coldRebuild: z.object({ requests: count, costUsd: z.number(), byGapBandAndCause: z.array(cellSchema) }),
  compactions: z.object({ total: count, manual: count, auto: count, midLoop: count, droppedTokens: count }),
  topSessions: z.array(
    z.object({
      sessionId: z.string(),
      sessionClass: z.string(),
      role: z.string(),
      initiative: z.string(),
      account: z.string(),
      requests: count,
      costUsd: z.number(),
    }),
  ),
  unpricedModels: z.array(z.object({ model: z.string(), requests: count, tokens: count })),
  coverage: z.object({ transcriptsIndexed: count, transcriptsDiscovered: count.nullable(), facetBacklog: count }),
});

export type CostReport = z.infer<typeof costReportSchema>;
export type CostBucket = z.infer<typeof bucketSchema>;
export type WakeCauseBucket = CostReport["byWakeCause"][number];
export type WakeGapCell = z.infer<typeof cellSchema>;

export interface CostReportOptions {
  /** ISO timestamp or date, inclusive. Overrides `days`. */
  since?: string;
  /** ISO timestamp or date, exclusive. */
  until?: string;
  /** Window length ending at `until`, or at `now` when `until` is absent. */
  days?: number;
  now?: Date;
  /** Sessions listed in `topSessions`. */
  top?: number;
  /** Transcripts the caller discovered on disk; the graph cannot know this. */
  transcriptsDiscovered?: number;
  /** The extraction version an audit facet must reach to count as current. */
  facetVersion?: number;
}

/** AskUserQuestion answers are the human answering, so they count under `human` (decisions Q4). */
const HUMAN_CAUSES: readonly string[] = ["human_typed", "ask_user_answer"];
const NONE = "none";
const DEFAULT_TOP = 10;
const DAY_MS = 86_400_000;

interface SessionTags {
  sessionClass: SessionClass;
  role: string;
  initiative: string;
  account: string;
}

type TaggedRow = CostRow & SessionTags;

/** Reads the graph and never writes it, so a read-only connection is enough. */
export function costReport(db: Db, options: CostReportOptions = {}): CostReport {
  const window = resolveWindow(options);
  const costRows = readCostRows(db, window);
  const sessionIds = [...new Set(costRows.map((row) => row.sessionId))];
  const tags = tagSessions(readSessionContexts(db, sessionIds));
  const rows = costRows.map((row) => ({ ...row, ...tags.get(row.sessionId)! }));
  return {
    window,
    priceTableVersion: readPriceTableVersion(db),
    totals: { ...sumOf(rows), sessions: sessionIds.length, unpricedRequests: rows.filter((row) => !row.priced).length },
    byTokenClass: tokenClasses(rows),
    ...dimensionBuckets(rows),
    byWakeCause: wakeCauses(rows),
    wakeCauseByGapBand: gapCells(rows),
    coldRebuild: coldRebuild(rows),
    compactions: compactionCounts(readCompactions(db, window)),
    topSessions: topSessions(rows, options.top ?? DEFAULT_TOP),
    unpricedModels: unpricedModels(rows),
    coverage: { ...readCoverage(db, options.facetVersion ?? null), transcriptsDiscovered: options.transcriptsDiscovered ?? null },
  };
}

export function resolveWindow(options: CostReportOptions): ReportWindow {
  const until = options.until ?? null;
  if (options.since !== undefined) return { since: options.since, until };
  if (options.days === undefined) return { since: null, until };
  const end = until ? Date.parse(until) : (options.now ?? new Date()).getTime();
  return { since: new Date(end - options.days * DAY_MS).toISOString(), until };
}

function tagSessions(contexts: Map<string, SessionContext>): Map<string, SessionTags> {
  const tags = new Map<string, SessionTags>();
  for (const [sessionId, context] of contexts) {
    const { sessionClass, humanRole } = classifySession(context.facts);
    tags.set(sessionId, {
      sessionClass,
      role: humanRole ?? (sessionClass === "agent_spawned" ? `worker:${context.facts.origin?.profile ?? "unknown"}` : sessionClass),
      initiative: sessionInitiative(context.tasks, context.cwd),
      account: context.account ?? "unknown",
    });
  }
  return tags;
}

function sumOf(rows: readonly CostRow[]): { requests: number; costUsd: number } {
  return { requests: rows.length, costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0) };
}

function tokenClasses(rows: readonly CostRow[]): CostReport["byTokenClass"] {
  const pick: Record<TokenClass, (row: CostRow) => [number, number]> = {
    input: (row) => [row.inputTokens, row.inputCostUsd],
    cache_read: (row) => [row.cacheReadTokens, row.cacheReadCostUsd],
    cache_write_5m: (row) => [row.cacheWrite5mTokens, row.cacheWrite5mCostUsd],
    cache_write_1h: (row) => [row.cacheWrite1hTokens, row.cacheWrite1hCostUsd],
    output: (row) => [row.outputTokens, row.outputCostUsd],
  };
  return TOKEN_CLASSES.map((tokenClass) => {
    const pairs = rows.map(pick[tokenClass]);
    return { tokenClass, tokens: pairs.reduce((sum, [tokens]) => sum + tokens, 0), costUsd: pairs.reduce((sum, [, cost]) => sum + cost, 0) };
  });
}

function dimensionBuckets(rows: readonly TaggedRow[]) {
  return {
    byAccount: bucketsBy(rows, (row) => row.account),
    byModel: bucketsBy(rows, (row) => row.model),
    byClass: bucketsBy(rows, (row) => row.sessionClass),
    byRole: bucketsBy(rows, (row) => row.role),
    byInitiative: bucketsBy(rows, (row) => row.initiative),
    byContextBand: bucketsBy(rows, (row) => row.contextBand),
  };
}

/** Most expensive first; ties by key so the report is stable. */
function bucketsBy<T extends CostRow>(rows: readonly T[], keyOf: (row: T) => string): CostBucket[] {
  const groups = groupRows(rows, keyOf);
  return [...groups]
    .map(([key, members]) => ({ key, ...sumOf(members), sessions: new Set(members.map((row) => row.sessionId)).size }))
    .sort(byCostThenKey);
}

function groupRows<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function byCostThenKey(a: { key: string; costUsd: number }, b: { key: string; costUsd: number }): number {
  return b.costUsd - a.costUsd || a.key.localeCompare(b.key);
}

function wakeCauses(rows: readonly CostRow[]): WakeCauseBucket[] {
  const causeOf = (row: CostRow) => row.wakeCause ?? NONE;
  const groupOf = (row: CostRow) => (HUMAN_CAUSES.includes(causeOf(row)) ? "human" : causeOf(row));
  return [...groupRows(rows, groupOf)]
    .map(([key, members]) => ({
      ...wakePart(key, members),
      parts: key === "human" ? [...groupRows(members, causeOf)].map(([cause, part]) => wakePart(cause, part)).sort(byCostThenKey) : [],
    }))
    .sort(byCostThenKey);
}

function wakePart(key: string, rows: readonly CostRow[]) {
  const midLoop = rows.filter((row) => row.wakeDelivery === "mid_loop");
  const sessions = new Set(rows.map((row) => row.sessionId)).size;
  return { key, ...sumOf(rows), sessions, midLoopRequests: midLoop.length, midLoopCostUsd: sumOf(midLoop).costUsd };
}

function gapCells(rows: readonly CostRow[]): WakeGapCell[] {
  const keyOf = (row: CostRow) => JSON.stringify([row.wakeCause ?? NONE, row.gapBand ?? NONE]);
  return [...groupRows(rows, keyOf)]
    .map(([key, members]) => {
      const [wakeCause, gapBand] = JSON.parse(key) as [string, string];
      return { wakeCause, gapBand, ...sumOf(members) };
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.wakeCause.localeCompare(b.wakeCause) || a.gapBand.localeCompare(b.gapBand));
}

function coldRebuild(rows: readonly CostRow[]): CostReport["coldRebuild"] {
  const cold = rows.filter((row) => row.isCold);
  return { ...sumOf(cold), byGapBandAndCause: gapCells(cold) };
}

function compactionCounts(rows: readonly CompactionRow[]): CostReport["compactions"] {
  return {
    total: rows.length,
    manual: rows.filter((row) => row.trigger === "manual").length,
    auto: rows.filter((row) => row.trigger === "auto").length,
    midLoop: rows.filter((row) => row.midLoop).length,
    droppedTokens: rows.reduce((sum, row) => sum + (row.droppedTokens ?? 0), 0),
  };
}

function topSessions(rows: readonly TaggedRow[], top: number): CostReport["topSessions"] {
  return [...groupRows(rows, (row) => row.sessionId)]
    .map(([sessionId, members]) => {
      const { sessionClass, role, initiative, account } = members[0]!;
      return { sessionId, sessionClass, role, initiative, account, ...sumOf(members) };
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.sessionId.localeCompare(b.sessionId))
    .slice(0, top);
}

function unpricedModels(rows: readonly CostRow[]): CostReport["unpricedModels"] {
  const unpriced = rows.filter((row) => !row.priced);
  return [...groupRows(unpriced, (row) => row.model)]
    .map(([model, members]) => ({ model, requests: members.length, tokens: members.reduce((sum, row) => sum + tokensOf(row), 0) }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
}

function tokensOf(row: CostRow): number {
  return row.inputTokens + row.cacheReadTokens + row.cacheWrite5mTokens + row.cacheWrite1hTokens + row.outputTokens;
}
