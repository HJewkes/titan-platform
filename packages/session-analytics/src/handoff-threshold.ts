import { z } from "zod";
import { priceRequest, type RequestTokens } from "./price-request.js";
import { PRICE_TABLE, findPrice, type PriceRow } from "./prices.js";
import type { ActionCall } from "./turn-action.js";

/** A dispatch or a send; with any file write, the first such request ends a session's boot. */
export const BOOT_TOOL = /(agent_(spawn|resume)|chat_(send|broadcast))$/;

/** The charter's `teleport_k` and `retire_k` at the time of the TP-499 plan; callers pass their own. */
export const DEFAULT_CONFIGURED_K: readonly number[] = [170_000, 250_000];
export const DEFAULT_K_SWEEP = { fromK: 20_000, toK: 1_000_000, stepK: 5_000 } as const;
export const DEFAULT_REVIEWER_ROLE = "worker:reviewer";
export const DEFAULT_STANDING_ROLE = "worker:standing_peer";
export const DEFAULT_REVIEWER_PRS = 10;
/** The broker logs this when a seat starts handing over; `from` is the outgoing agent id. */
export const TELEPORT_EVENT = "teleport_started";

const MTOK = 1_000_000;
const count = z.number().int().nonnegative();
const kCostSchema = z.object({ k: count, costPerRequest: z.number().nullable(), deltaPerRequest: z.number().nullable() });
const sweepResultSchema = z.object({ bestK: count.nullable(), bestCostPerRequest: z.number().nullable(), atConfigured: z.array(kCostSchema) });
const paramsSchema = z.object({ bootCostUsd: z.number(), bootFill: z.number(), growthPerRequest: z.number(), readPricePerMTok: z.number() });

const sessionSchema = paramsSchema.extend({
  sessionId: z.string(),
  role: z.string(),
  model: z.string(),
  requests: count,
  bootRequests: count,
  exitFill: count,
  /** Timestamp of the session's last request; orders reviewer cohorts by recency. */
  lastTs: z.string(),
  bestK: count.nullable(),
});
const cohortSchema = paramsSchema.extend({
  role: z.string(),
  model: z.string(),
  sessions: count,
  ...sweepResultSchema.shape,
  /** The same sweep when only half the boot is overhead the next session pays again. */
  halfBoot: sweepResultSchema,
});
const teleportSchema = z.object({
  ts: z.string(),
  name: z.string().nullable(),
  sessionId: z.string(),
  role: z.string(),
  model: z.string(),
  exitFill: count,
  bestK: count.nullable(),
  /** Exit fill minus each configured K; positive means the seat left late. */
  overConfigured: z.array(z.object({ k: count, over: z.number() })),
});
/** `requestsFrom` when the report has no reviewer session at all, so requests per PR is 0. */
export const POOLED_REVIEWERS = "pooled";
const reviewerCostSchema = z.object({
  role: z.string(),
  model: z.string(),
  sessions: count,
  /** Mean requests after boot of a per-PR reviewer: the work each PR adds. */
  requestsPerPr: z.number(),
  /** The reviewer model whose sessions give `requestsPerPr`: the row's own, else the newest reviewer cohort; `pooled` with none. */
  requestsFrom: z.string(),
  costUsd: z.number(),
});
const reviewerSchema = z.object({ prs: count, fresh: z.array(reviewerCostSchema), standing: z.array(reviewerCostSchema) });

export const handoffThresholdSchema = z.object({
  configuredK: z.array(count),
  sweep: z.object({ fromK: count, toK: count, stepK: count }),
  cohorts: z.array(cohortSchema),
  sessions: z.array(sessionSchema),
  /** Sessions with no dispatch, send or write, or none priced: they have no boot to measure. */
  unbootedSessions: count,
  teleports: z.array(teleportSchema),
  unmatchedTeleports: count,
  /** Boot and cache reads for `prs` reviews: a fresh reviewer per PR against one standing reviewer. */
  reviewers: reviewerSchema,
});

export type HandoffThreshold = z.infer<typeof handoffThresholdSchema>;
export type HandoffCohort = z.infer<typeof cohortSchema>;
export type HandoffSession = z.infer<typeof sessionSchema>;
export type HandoffTeleport = z.infer<typeof teleportSchema>;
export type ReviewerComparison = z.infer<typeof reviewerSchema>;
export type CycleParams = z.infer<typeof paramsSchema>;
export type KSweep = HandoffThreshold["sweep"];

/** One main-thread request as the handoff model needs it. */
export interface HandoffRequestRow {
  sessionId: string;
  role: string;
  model: string;
  ts: string;
  /** Tokens in context: input, cache reads and cache writes. */
  fill: number;
  tokens: RequestTokens;
  bootAction: boolean;
}

export interface TeleportEvent {
  ts: string;
  name: string | null;
  fromAgentId: string;
}

export interface HandoffOptions {
  configuredK?: readonly number[];
  sweep?: KSweep;
  reviewerRole?: string;
  /** The role whose boot, fill and growth price a reviewer that stays up across PRs. */
  standingRole?: string;
  reviewerPrs?: number;
  /** Prices every request and the read rate; the package table, not the graph's stored one. */
  prices?: readonly PriceRow[];
}

export function isBootAction(calls: readonly ActionCall[]): boolean {
  return calls.some((call) => BOOT_TOOL.test(call.tool) || (call.writePaths?.length ?? 0) > 0);
}

/** Broker log lines to teleport starts; any other line, or one that is not JSON, is skipped. */
export function parseTeleportEvents(lines: Iterable<string>): TeleportEvent[] {
  const events: TeleportEvent[] = [];
  for (const line of lines) {
    const entry = parseJson(line);
    if (entry?.event !== TELEPORT_EVENT || typeof entry.from !== "string" || typeof entry.ts !== "string") continue;
    events.push({ ts: entry.ts, name: typeof entry.name === "string" ? entry.name : null, fromAgentId: entry.from });
  }
  return events;
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One cycle boots to f0 and grows g per request up to K: boot/n + read price x mean fill, with n = (K - f0) / g. */
export function costPerRequest(params: CycleParams, k: number): number | null {
  const requests = (k - params.bootFill) / params.growthPerRequest;
  if (!(params.growthPerRequest > 0) || requests < 1) return null;
  return params.bootCostUsd / requests + (params.readPricePerMTok / MTOK) * ((params.bootFill + k) / 2);
}

/** The cheapest K on the sweep grid, then each configured K against it. */
export function sweepK(params: CycleParams, sweep: KSweep, configuredK: readonly number[]): z.infer<typeof sweepResultSchema> {
  let best: { k: number; cost: number } | null = null;
  for (let k = sweep.fromK; k <= sweep.toK; k += sweep.stepK) {
    const cost = costPerRequest(params, k);
    if (cost !== null && (best === null || cost < best.cost)) best = { k, cost };
  }
  const atConfigured = configuredK.map((k) => {
    const cost = costPerRequest(params, k);
    return { k, costPerRequest: cost, deltaPerRequest: cost === null || best === null ? null : cost - best.cost };
  });
  return { bestK: best?.k ?? null, bestCostPerRequest: best?.cost ?? null, atConfigured };
}

/** Per role and model: boot cost and fill, fill growth and read price from the requests, then the K sweep. */
export function handoffThreshold(rows: readonly HandoffRequestRow[], teleports: readonly TeleportEvent[], agentSessions: ReadonlyMap<string, readonly string[]>, options: HandoffOptions = {}): HandoffThreshold {
  const configuredK = [...(options.configuredK ?? DEFAULT_CONFIGURED_K)];
  const sweep = { ...(options.sweep ?? DEFAULT_K_SWEEP) };
  const bySession = groupBy(rows, (row) => row.sessionId);
  const fits = [...bySession.values()].map((requests) => fitSession(requests, options.prices ?? PRICE_TABLE, sweep));
  const sessions = fits.filter((fit): fit is HandoffSession => fit !== null).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const cohorts = cohortsOf(sessions, sweep, configuredK);
  const matched = teleports.map((event) => teleportExit(event, agentSessions, bySession, cohorts, configuredK)).filter((t): t is HandoffTeleport => t !== null);
  return {
    configuredK,
    sweep,
    cohorts,
    sessions,
    unbootedSessions: fits.length - sessions.length,
    teleports: matched.sort((a, b) => a.ts.localeCompare(b.ts)),
    unmatchedTeleports: teleports.length - matched.length,
    reviewers: reviewerComparison(sessions, options.reviewerRole ?? DEFAULT_REVIEWER_ROLE, options.standingRole ?? DEFAULT_STANDING_ROLE, options.reviewerPrs ?? DEFAULT_REVIEWER_PRS),
  };
}

function fitSession(unsorted: readonly HandoffRequestRow[], prices: readonly PriceRow[], sweep: KSweep): HandoffSession | null {
  const requests = [...unsorted].sort((a, b) => a.ts.localeCompare(b.ts));
  const first = requests[0]!;
  const bootIndex = requests.findIndex((row) => row.bootAction);
  const price = findPrice(first.model, first.ts, prices);
  if (bootIndex < 0 || price === null) return null;
  const params: CycleParams = {
    bootCostUsd: requests.slice(0, bootIndex + 1).reduce((sum, row) => sum + priceRequest(row.tokens, row.model, row.ts, prices).costUsd, 0),
    bootFill: requests[bootIndex]!.fill,
    growthPerRequest: meanGrowth(requests.slice(bootIndex).map((row) => row.fill)),
    readPricePerMTok: price.cacheRead,
  };
  const { sessionId, role, model } = first;
  const last = requests[requests.length - 1]!;
  return { sessionId, role, model, requests: requests.length, bootRequests: bootIndex + 1, exitFill: last.fill, lastTs: last.ts, ...params, bestK: sweepK(params, sweep, []).bestK };
}

/** Rises only, so a compaction's drop does not cancel the growth before it; zero with no request after boot. */
function meanGrowth(fills: readonly number[]): number {
  if (fills.length < 2) return 0;
  let rise = 0;
  for (let i = 1; i < fills.length; i += 1) rise += Math.max(0, fills[i]! - fills[i - 1]!);
  return rise / (fills.length - 1);
}

/** Session means per role and model; a model's read price differs, so it splits the role. */
function cohortsOf(sessions: readonly HandoffSession[], sweep: KSweep, configuredK: readonly number[]): HandoffCohort[] {
  return [...groupBy(sessions, (s) => JSON.stringify([s.role, s.model]))]
    .map(([, members]) => {
      const params = meanParams(members);
      return {
        role: members[0]!.role,
        model: members[0]!.model,
        sessions: members.length,
        ...params,
        ...sweepK(params, sweep, configuredK),
        halfBoot: sweepK({ ...params, bootCostUsd: params.bootCostUsd / 2 }, sweep, configuredK),
      };
    })
    .sort((a, b) => a.role.localeCompare(b.role) || a.model.localeCompare(b.model));
}

function meanParams(sessions: readonly HandoffSession[]): CycleParams {
  const mean = (pick: (s: HandoffSession) => number) => sessions.reduce((sum, s) => sum + pick(s), 0) / sessions.length;
  return {
    bootCostUsd: mean((s) => s.bootCostUsd),
    bootFill: mean((s) => s.bootFill),
    growthPerRequest: meanGrowthOf(sessions),
    readPricePerMTok: mean((s) => s.readPricePerMTok),
  };
}

/** Sessions with no request after boot have g = 0; counting them would dilute the growth of those that grew. */
function meanGrowthOf(sessions: readonly HandoffSession[]): number {
  const grown = sessions.filter((s) => s.growthPerRequest > 0);
  return grown.length === 0 ? 0 : grown.reduce((sum, s) => sum + s.growthPerRequest, 0) / grown.length;
}

/** The fill of the outgoing session's last request at or before the teleport. */
function teleportExit(
  event: TeleportEvent,
  agentSessions: ReadonlyMap<string, readonly string[]>,
  bySession: ReadonlyMap<string, readonly HandoffRequestRow[]>,
  cohorts: readonly HandoffCohort[],
  configuredK: readonly number[],
): HandoffTeleport | null {
  const candidates = (agentSessions.get(event.fromAgentId) ?? []).flatMap((id) => bySession.get(id) ?? []);
  const exit = candidates.filter((row) => row.ts <= event.ts).sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!exit) return null;
  const cohort = cohorts.find((c) => c.role === exit.role && c.model === exit.model);
  return {
    ts: event.ts,
    name: event.name,
    sessionId: exit.sessionId,
    role: exit.role,
    model: exit.model,
    exitFill: exit.fill,
    bestK: cohort?.bestK ?? null,
    overConfigured: configuredK.map((k) => ({ k, over: exit.fill - k })),
  };
}

/** Reads over m requests from f0 growing g each: m f0 + g m(m + 1) / 2 tokens at the read price. */
function readCost(params: CycleParams, requests: number): number {
  return ((requests * params.bootFill + (params.growthPerRequest * requests * (requests + 1)) / 2) * params.readPricePerMTok) / MTOK;
}

/** Fresh: every PR pays a boot and its own reads. Standing: one boot, then every PR's requests read the context the earlier ones left. */
function reviewerComparison(sessions: readonly HandoffSession[], reviewerRole: string, standingRole: string, prs: number): ReviewerComparison {
  const cohorts = (role: string) => [...groupBy(sessions.filter((s) => s.role === role), (s) => s.model)].sort(([a], [b]) => a.localeCompare(b));
  const reviewers = cohorts(reviewerRole);
  const perPr = new Map(reviewers.map(([model, members]) => [model, meanRequestsAfterBoot(members)]));
  const newest = newestCohort(reviewers);
  const priced = (role: string, costOf: (params: CycleParams, requests: number) => number) =>
    cohorts(role).map(([model, members]) => {
      const from = perPr.has(model) ? model : newest;
      const requestsPerPr = from === null ? 0 : perPr.get(from)!;
      return { role, model, sessions: members.length, requestsPerPr, requestsFrom: from ?? POOLED_REVIEWERS, costUsd: costOf(meanParams(members), requestsPerPr) };
    });
  return {
    prs,
    fresh: priced(reviewerRole, (params, requests) => prs * (params.bootCostUsd + readCost(params, requests))),
    standing: priced(standingRole, (params, requests) => params.bootCostUsd + readCost(params, prs * requests)),
  };
}

/** The reviewer model whose latest session is newest; a tie goes to the later model name. */
function newestCohort(reviewers: readonly (readonly [string, readonly HandoffSession[]])[]): string | null {
  const latest = reviewers.map(([model, members]) => ({ model, ts: members.reduce((max, s) => (s.lastTs > max ? s.lastTs : max), "") }));
  latest.sort((a, b) => b.ts.localeCompare(a.ts) || b.model.localeCompare(a.model));
  return latest[0]?.model ?? null;
}

function meanRequestsAfterBoot(sessions: readonly HandoffSession[]): number {
  return sessions.length === 0 ? 0 : sessions.reduce((sum, s) => sum + s.requests - s.bootRequests, 0) / sessions.length;
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}
