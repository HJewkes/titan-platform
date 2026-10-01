import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { classifySession, type SessionClass } from "./classify-session.js";
import {
  readAgentNames,
  readCompactions,
  readCostRows,
  readCoverage,
  readAgentSessions,
  readPriceTableVersion,
  readRequestEvents,
  readSessionContexts,
  readWakeEvents,
  type CompactionRow,
  type CostRow,
  type ReportWindow,
  type SessionContext,
} from "./cost-report-queries.js";
import { assignmentCount, heuristicFor } from "./episodes.js";
import { handoffThreshold, handoffThresholdSchema, isBootAction, parseTeleportEvents, type HandoffOptions, type HandoffThreshold } from "./handoff-threshold.js";
import { sessionInitiative } from "./initiative.js";
import { readRequestToolCalls } from "./request-owner.js";
import { sessionRole } from "./roles.js";
import { scopeFilter, type ReportScope } from "./scope.js";
import {
  ACTION_CLASSES,
  DEFAULT_ACTION_RULES,
  DEFAULT_MECHANICAL_CLASSES,
  classifyRequest,
  type ActionClass,
  type ActionRule,
} from "./turn-action.js";
import {
  DEFAULT_EPISODE_ROLES,
  DEFAULT_NO_ACTION_CLASSES,
  buildWakeEpisodes,
  episodeNames,
  summarizeWakeEpisodes,
  wakeEpisodesSchema,
  type WakeEpisodes,
} from "./wake-episodes.js";

const count = z.number().int().nonnegative();
const bucketSchema = z.object({ key: z.string(), requests: count, sessions: count, costUsd: z.number() });
const wakePartSchema = bucketSchema.extend({ midLoopRequests: count, midLoopCostUsd: z.number() });
const cellSchema = z.object({ wakeCause: z.string(), gapBand: z.string(), requests: count, costUsd: z.number() });
const fraction = z.number().min(0).max(1);
const roleShareSchema = z.object({ role: z.string(), costUsd: z.number(), share: fraction });

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
  /** Per role, cost by the action class of each request, from the tool calls it issued. */
  byAction: z.array(z.object({ role: z.string(), buckets: z.array(bucketSchema) })),
  /** Cost of the mechanical action classes over the window total; each role's share is over that role's cost. */
  mechanicalShare: z.object({ classes: z.array(z.enum(ACTION_CLASSES)), costUsd: z.number(), share: fraction, byRole: z.array(roleShareSchema) }),
  /** Sessions by how many episodes their class's heuristic cut them into; `none` when not yet segmented. */
  byEpisodeCount: z.array(bucketSchema),
  byInitiative: z.array(bucketSchema),
  byContextBand: z.array(bucketSchema),
  byWakeCause: z.array(wakePartSchema.extend({ parts: z.array(wakePartSchema) })),
  /** Per wake episode of the episode roles: an arrival and the requests up to the next one, mid-loop deliveries included. */
  wakeEpisodes: wakeEpisodesSchema,
  /** Per role and model, the handoff threshold K that minimises boot plus cache-read cost per request. */
  handoffThreshold: handoffThresholdSchema,
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
export type RoleActions = CostReport["byAction"][number];
export type MechanicalShare = CostReport["mechanicalShare"];

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
  /** Action rules in precedence order; seat-specific rules belong in the caller's config. */
  actionRules?: readonly ActionRule[];
  /** Action classes counted as mechanical in `mechanicalShare`. */
  mechanicalClasses?: readonly ActionClass[];
  /** Report roles whose wakes `wakeEpisodes` cuts into episodes. */
  episodeRoles?: readonly string[];
  /** A wake is no-action when every one of its requests falls in these action classes. */
  noActionClasses?: readonly ActionClass[];
  /** The broker log's lines, read by the caller; its teleport starts give each handoff's exit fill. */
  brokerLogLines?: () => Iterable<string>;
  handoff?: HandoffOptions;
  /** Narrows every request-keyed field to some sessions; absent means all. */
  scope?: ReportScope;
}

/** AskUserQuestion answers are the human answering, so they count under `human` (decisions Q4). */
const HUMAN_CAUSES: readonly string[] = ["human_typed", "ask_user_answer"];
const NONE = "none";
const DEFAULT_TOP = 10;
const EPISODE_COUNT_CAP = 5;
const DAY_MS = 86_400_000;

interface SessionTags {
  sessionClass: SessionClass;
  role: string;
  episodeCount: string;
  initiative: string;
  account: string;
}

type TaggedRow = CostRow & SessionTags & { action: ActionClass; bootAction: boolean };

/** Reads the graph and never writes it, so a read-only connection is enough. */
export function costReport(db: Db, options: CostReportOptions = {}): CostReport {
  const window = resolveWindow(options);
  const rows = readTaggedRows(db, window, options.actionRules ?? DEFAULT_ACTION_RULES).filter(scopeFilter(db, options.scope));
  return {
    window,
    priceTableVersion: readPriceTableVersion(db),
    totals: { ...sumOf(rows), sessions: new Set(rows.map((row) => row.sessionId)).size, unpricedRequests: rows.filter((row) => !row.priced).length },
    byTokenClass: tokenClasses(rows),
    ...dimensionBuckets(rows),
    byAction: roleActions(rows),
    mechanicalShare: mechanicalShare(rows, options.mechanicalClasses ?? DEFAULT_MECHANICAL_CLASSES),
    byWakeCause: wakeCauses(rows),
    wakeEpisodes: wakeEpisodes(db, window, rows, options),
    handoffThreshold: handoff(db, window, rows, options),
    wakeCauseByGapBand: gapCells(rows),
    coldRebuild: coldRebuild(rows),
    compactions: compactionCounts(readCompactions(db, window)),
    topSessions: topSessions(rows, options.top ?? DEFAULT_TOP),
    unpricedModels: unpricedModels(rows),
    coverage: { ...readCoverage(db, options.facetVersion ?? null), transcriptsDiscovered: options.transcriptsDiscovered ?? null },
  };
}

function readTaggedRows(db: Db, window: ReportWindow, rules: readonly ActionRule[]): TaggedRow[] {
  const costRows = readCostRows(db, window);
  const tags = tagSessions(readSessionContexts(db, [...new Set(costRows.map((row) => row.sessionId))]));
  const calls = readRequestToolCalls(db, window);
  return costRows.map((row) => {
    const requestCalls = calls.get(row.requestId) ?? [];
    return { ...row, ...tags.get(row.sessionId)!, action: classifyRequest(requestCalls, rules), bootAction: isBootAction(requestCalls) };
  });
}

export function resolveWindow(options: CostReportOptions): ReportWindow {
  const until = options.until ?? null;
  if (options.since !== undefined) return { since: options.since, until };
  if (options.days === undefined) return { since: null, until };
  const end = until ? Date.parse(until) : (options.now ?? new Date()).getTime();
  return { since: new Date(end - options.days * DAY_MS).toISOString(), until };
}

export function tagSessions(contexts: Map<string, SessionContext>): Map<string, SessionTags> {
  const tags = new Map<string, SessionTags>();
  for (const [sessionId, context] of contexts) {
    const classification = classifySession(context.facts);
    const episodes = context.episodes.filter((episode) => episode.heuristic === heuristicFor(classification.sessionClass));
    const worker = { profile: context.facts.origin?.profile, lifetimeMs: context.lifetimeMs, assignments: assignmentCount(episodes) };
    tags.set(sessionId, {
      sessionClass: classification.sessionClass,
      role: sessionRole(classification, worker),
      episodeCount: episodeCountKey(episodes.length),
      initiative: sessionInitiative(context.tasks, context.cwd),
      account: context.account ?? "unknown",
    });
  }
  return tags;
}

/** The worker report's assignment buckets: 1, 2, 3, 4, 5+. */
function episodeCountKey(episodes: number): string {
  if (episodes === 0) return NONE;
  return episodes >= EPISODE_COUNT_CAP ? `${EPISODE_COUNT_CAP}+` : String(episodes);
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
    byEpisodeCount: bucketsBy(rows, (row) => row.episodeCount),
    byInitiative: bucketsBy(rows, (row) => row.initiative),
    byContextBand: bucketsBy(rows, (row) => row.contextBand),
  };
}

/** Roles most expensive first, the same order as `byRole`. */
function roleActions(rows: readonly TaggedRow[]): RoleActions[] {
  return [...groupRows(rows, (row) => row.role)]
    .map(([role, members]) => ({ key: role, costUsd: sumOf(members).costUsd, buckets: bucketsBy(members, (row) => row.action) }))
    .sort(byCostThenKey)
    .map(({ key, buckets }) => ({ role: key, buckets }));
}

function mechanicalShare(rows: readonly TaggedRow[], classes: readonly ActionClass[]): MechanicalShare {
  const isMechanical = (row: TaggedRow) => classes.includes(row.action);
  const shareOf = (members: readonly TaggedRow[]) => {
    const costUsd = sumOf(members.filter(isMechanical)).costUsd;
    return { costUsd, share: ratio(costUsd, sumOf(members).costUsd) };
  };
  const byRole = [...groupRows(rows, (row) => row.role)]
    .map(([role, members]) => ({ role, ...shareOf(members) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.role.localeCompare(b.role));
  return { classes: [...classes], ...shareOf(rows), byRole };
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? Math.min(part / whole, 1) : 0;
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

function wakeEpisodes(db: Db, window: ReportWindow, rows: readonly TaggedRow[], options: CostReportOptions): WakeEpisodes {
  const roles = options.episodeRoles ?? DEFAULT_EPISODE_ROLES;
  const noActionClasses = options.noActionClasses ?? DEFAULT_NO_ACTION_CLASSES;
  const members = rows.filter((row) => roles.includes(row.role));
  const sessionIds = [...new Set(members.map((row) => row.sessionId))];
  const eventOf = readRequestEvents(db, window, sessionIds);
  const requests = members.map((row) => ({ costUsd: row.costUsd, action: row.action, eventKey: eventOf.get(row.requestId) ?? null }));
  const episodes = buildWakeEpisodes(readWakeEvents(db, window, sessionIds), requests, episodeNames(readAgentNames(db)), noActionClasses);
  return summarizeWakeEpisodes(episodes, requests, roles, noActionClasses);
}

function handoff(db: Db, window: ReportWindow, rows: readonly TaggedRow[], options: CostReportOptions): HandoffThreshold {
  const inWindow = (ts: string) => (window.since === null || ts >= window.since) && (window.until === null || ts < window.until);
  const teleports = parseTeleportEvents(options.brokerLogLines?.() ?? []).filter((event) => inWindow(event.ts));
  const requests = rows
    .filter((row) => !row.isSidechain)
    .map((row) => ({
      sessionId: row.sessionId,
      role: row.role,
      model: row.model,
      ts: row.ts,
      fill: row.contextTokens,
      tokens: { inputTokens: row.inputTokens, cacheReadTokens: row.cacheReadTokens, cacheCreation5mTokens: row.cacheWrite5mTokens, cacheCreation1hTokens: row.cacheWrite1hTokens, outputTokens: row.outputTokens },
      bootAction: row.bootAction,
    }));
  return handoffThreshold(requests, teleports, readAgentSessions(db), options.handoff);
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
