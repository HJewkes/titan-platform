import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { reverseReplayTokens, reverseSavingUsd } from "./cache-ttl-replay.js";
import { noCacheSavingUsd } from "./cache-ttl-nocache.js";
import { GAP_CAUSES, gapCauseOf, type GapCause } from "./cache-ttl-gap-cause.js";
import { readRequestToolCalls } from "./request-owner.js";
import { GAP_BANDS, gapBand } from "./bands.js";
import { readSessionContexts, type ReportWindow } from "./cost-report-queries.js";
import { resolveWindow, tagSessions, type CostReportOptions } from "./cost-report.js";
import { PRICE_TABLE, PRICE_TABLE_VERSION, findPrice, type PriceRow } from "./prices.js";
import { LIST_PRICE_CAVEAT, table, usd } from "./render-text.js";
import { scopeFilter } from "./scope.js";

const FIVE_MINUTES_MS = 5 * 60_000;
const MTOK = 1e6;
const NO_PROFILE = "none";

/** Gap bands past a 5-minute TTL: the next request finds the cache gone. */
export const REBUILD_GAP_BANDS: readonly string[] = GAP_BANDS.filter((band) => band.lo >= FIVE_MINUTES_MS).map((band) => band.name);

/** One request as the TTL what-if needs it. */
export interface TtlRequestRow {
  sessionId: string;
  role: string;
  profile: string;
  model: string;
  ts: string;
  cacheReadTokens: number;
  cacheWrite1hTokens: number;
  cacheWrite5mTokens: number;
  /** Milliseconds since the session's previous request; null for its first. */
  gapMs: number | null;
  /** The previous request's last action in the same chain; absent reads as `end-of-turn`. */
  previousAction?: GapCause;
}

const count = z.number().int().nonnegative();
const effectFields = {
  sessions: count,
  requests: count,
  write1hTokens: count,
  /** 1h writes repriced at the 5m write rate. */
  repriceSavingUsd: z.number(),
  rebuilds: count,
  rebuildTokens: count,
  /** Each rebuild writes at the 5m rate what the 1h cache still served as a read. */
  rebuildCostUsd: z.number(),
  netSavingUsd: z.number(),
  netPerSessionUsd: z.number(),
  /** Cost today less cost with every prompt token at the input rate; positive means no cache is cheaper. */
  noCacheNetUsd: z.number(),
  /** Rebuild writes of sessions already on 5m that a 1h TTL would have served as reads. */
  reverseReverts: count,
  reverseTokens: count,
  /** Saving from replaying those 5m sessions at 1h, before any 1h write premium. */
  reverseSavingUsd: z.number(),
};
const bucketSchema = z.object({ key: z.string(), ...effectFields, fiveMinuteLoses: z.boolean(), noCacheCheaper: z.boolean() });

export const cacheTtlWhatIfSchema = z.object({
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }).optional(),
  priceTableVersion: z.number().int(),
  rebuildGapBands: z.array(z.string()),
  totals: z.object(effectFields),
  unpricedRequests: count,
  byRole: z.array(bucketSchema),
  byProfile: z.array(bucketSchema),
  /** Roles whose rebuilds after long gaps outweigh the cheaper writes. */
  lossRoles: z.array(z.string()),
  /** Rebuilds split by the last action before the gap, one entry per cause in a fixed order. */
  byGapCause: z.array(z.object({ cause: z.enum(GAP_CAUSES), rebuilds: count, rebuildTokens: count, rebuildCostUsd: z.number() })),
});

export type CacheTtlWhatIf = z.infer<typeof cacheTtlWhatIfSchema>;
export type CacheTtlBucket = z.infer<typeof bucketSchema>;

interface RequestEffect {
  sessionId: string;
  gapCause: GapCause;
  write1hTokens: number;
  repriceSavingUsd: number;
  rebuildTokens: number;
  rebuildCostUsd: number;
  noCacheSavingUsd: number;
  reverseTokens: number;
  reverseSavingUsd: number;
}

/** Q3: what each role and profile would have paid with `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` instead of 1h. */
export function cacheTtlWhatIf(rows: readonly TtlRequestRow[], prices: readonly PriceRow[] = PRICE_TABLE): CacheTtlWhatIf {
  const priced = rows.filter((row) => findPrice(row.model, row.ts, prices));
  const reverted = reverseReplayTokens(priced);
  const effects = new Map<TtlRequestRow, RequestEffect>();
  for (const row of priced) effects.set(row, requestEffect(row, findPrice(row.model, row.ts, prices)!, reverted.get(row) ?? 0));
  const byRole = buckets(priced, effects, (row) => row.role);
  return {
    priceTableVersion: PRICE_TABLE_VERSION,
    rebuildGapBands: [...REBUILD_GAP_BANDS],
    totals: sumEffects([...effects.values()]),
    unpricedRequests: rows.length - priced.length,
    byRole,
    byProfile: buckets(priced, effects, (row) => row.profile),
    lossRoles: byRole.filter((bucket) => bucket.fiveMinuteLoses).map((bucket) => bucket.key),
    byGapCause: byGapCause([...effects.values()]),
  };
}

function requestEffect(row: TtlRequestRow, price: PriceRow, reverseTokens: number): RequestEffect {
  const band = row.gapMs === null ? null : gapBand(row.gapMs);
  const rebuildTokens = band !== null && REBUILD_GAP_BANDS.includes(band) ? row.cacheReadTokens : 0;
  return {
    sessionId: row.sessionId,
    gapCause: row.previousAction ?? "end-of-turn",
    write1hTokens: row.cacheWrite1hTokens,
    repriceSavingUsd: (row.cacheWrite1hTokens * (price.cacheWrite1h - price.cacheWrite5m)) / MTOK,
    rebuildTokens,
    rebuildCostUsd: (rebuildTokens * (price.cacheWrite5m - price.cacheRead)) / MTOK,
    noCacheSavingUsd: noCacheSavingUsd(row, price),
    reverseTokens,
    reverseSavingUsd: reverseSavingUsd(reverseTokens, price),
  };
}

function byGapCause(effects: readonly RequestEffect[]): CacheTtlWhatIf["byGapCause"] {
  return GAP_CAUSES.map((cause) => {
    const rebuilt = effects.filter((effect) => effect.gapCause === cause && effect.rebuildTokens > 0);
    return {
      cause,
      rebuilds: rebuilt.length,
      rebuildTokens: rebuilt.reduce((total, effect) => total + effect.rebuildTokens, 0),
      rebuildCostUsd: rebuilt.reduce((total, effect) => total + effect.rebuildCostUsd, 0),
    };
  });
}

function sumEffects(effects: readonly RequestEffect[]): CacheTtlWhatIf["totals"] {
  const sum = (pick: (effect: RequestEffect) => number) => effects.reduce((total, effect) => total + pick(effect), 0);
  const sessions = new Set(effects.map((effect) => effect.sessionId)).size;
  const netSavingUsd = sum((effect) => effect.repriceSavingUsd - effect.rebuildCostUsd);
  return {
    sessions,
    requests: effects.length,
    write1hTokens: sum((effect) => effect.write1hTokens),
    repriceSavingUsd: sum((effect) => effect.repriceSavingUsd),
    rebuilds: effects.filter((effect) => effect.rebuildTokens > 0).length,
    rebuildTokens: sum((effect) => effect.rebuildTokens),
    rebuildCostUsd: sum((effect) => effect.rebuildCostUsd),
    netSavingUsd,
    netPerSessionUsd: sessions > 0 ? netSavingUsd / sessions : 0,
    noCacheNetUsd: sum((effect) => effect.noCacheSavingUsd),
    reverseReverts: effects.filter((effect) => effect.reverseTokens > 0).length,
    reverseTokens: sum((effect) => effect.reverseTokens),
    reverseSavingUsd: sum((effect) => effect.reverseSavingUsd),
  };
}

/** Largest saving first, so the roles 5m would cost money sit at the bottom. */
function buckets(rows: readonly TtlRequestRow[], effects: Map<TtlRequestRow, RequestEffect>, keyOf: (row: TtlRequestRow) => string): CacheTtlBucket[] {
  const groups = new Map<string, RequestEffect[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const members = groups.get(key);
    if (members) members.push(effects.get(row)!);
    else groups.set(key, [effects.get(row)!]);
  }
  return [...groups]
    .map(([key, members]) => {
      const totals = sumEffects(members);
      return { key, ...totals, fiveMinuteLoses: totals.netSavingUsd < 0, noCacheCheaper: totals.noCacheNetUsd > 0 };
    })
    .sort((a, b) => b.netSavingUsd - a.netSavingUsd || a.key.localeCompare(b.key));
}

const IN_WINDOW = "(@since IS NULL OR ts >= @since) AND (@until IS NULL OR ts < @until)";

// The miner leaves `gap_ms` null, so the gap falls back to the session's previous request, even one before the window.
const TTL_ROWS = `
  WITH member AS (SELECT DISTINCT session_id FROM request_dedup WHERE ${IN_WINDOW}),
  timed AS (
    SELECT session_id, request_id, model, ts, cache_read_tokens, cache_creation_1h, cache_creation_5m, cache_creation_tokens, gap_ms,
      LAG(ts) OVER (PARTITION BY session_id, is_sidechain ORDER BY ts, request_id) AS previous_ts,
      LAG(request_id) OVER (PARTITION BY session_id, is_sidechain ORDER BY ts, request_id) AS previous_request_id
    FROM request_dedup WHERE session_id IN member
  )
  SELECT session_id AS sessionId, previous_request_id AS previousRequestId, model, ts, cache_read_tokens AS cacheReadTokens, cache_creation_1h AS cacheWrite1hTokens,
    CASE WHEN cache_creation_5m + cache_creation_1h = 0 THEN cache_creation_tokens ELSE cache_creation_5m END AS cacheWrite5mTokens,
    COALESCE(gap_ms, CAST(ROUND((julianday(ts) - julianday(previous_ts)) * 86400000) AS INTEGER)) AS gapMs
  FROM timed WHERE ${IN_WINDOW}`;

/** Reads the graph and never writes it; roles are the cost report's. */
export function cacheTtlReport(db: Db, options: CostReportOptions = {}, prices: readonly PriceRow[] = PRICE_TABLE): CacheTtlWhatIf {
  const window = resolveWindow(options);
  return { window, ...cacheTtlWhatIf(readTtlRows(db, window).filter(scopeFilter(db, options.scope)), prices) };
}

type QueriedRow = Omit<TtlRequestRow, "role" | "profile" | "previousAction"> & { previousRequestId: string | null };

export function readTtlRows(db: Db, window: ReportWindow): TtlRequestRow[] {
  const rows = db.prepare<[object], QueriedRow>(TTL_ROWS).all(window);
  // The previous request may predate the window, so its calls are read from the start.
  const calls = readRequestToolCalls(db, { since: null, until: window.until });
  const contexts = readSessionContexts(db, [...new Set(rows.map((row) => row.sessionId))]);
  const tags = tagSessions(contexts);
  return rows.map(({ previousRequestId, ...row }) => ({
    ...row,
    previousAction: gapCauseOf(previousRequestId ? calls.get(previousRequestId) : undefined),
    role: tags.get(row.sessionId)!.role,
    profile: contexts.get(row.sessionId)!.facts.origin?.profile ?? NO_PROFILE,
  }));
}

/** One table per dimension; a role or profile 5m would cost money is marked `loss`. */
export function renderCacheTtlText(whatIf: CacheTtlWhatIf): string {
  const { totals, window } = whatIf;
  const span = window ? `, ${window.since ?? "beginning"} to ${window.until ?? "now"}` : "";
  const header = [
    `Cache TTL what-if, 5m against 1h${span}`,
    `Net ${usd(totals.netSavingUsd)} over ${totals.sessions} sessions: 1h writes repriced save ${usd(totals.repriceSavingUsd)}, ` +
      `${totals.rebuilds} rebuilds after gaps in ${whatIf.rebuildGapBands.join(", ")} cost ${usd(totals.rebuildCostUsd)}`,
    `Roles where 5m loses: ${whatIf.lossRoles.join(", ") || "none"}`,
    `No cache (every prompt token at the input rate) nets ${usd(totals.noCacheNetUsd)}; flagged where it is cheaper`,
    `Rebuilds by last action before the gap: ${whatIf.byGapCause.map((c) => `${c.cause} ${c.rebuilds} (${usd(c.rebuildCostUsd)})`).join(", ")}`,
    `Replaying 5m sessions at 1h turns ${totals.reverseReverts} rebuilds into reads, saving ${usd(totals.reverseSavingUsd)} before the 1h write premium`,
  ].join("\n");
  const footer = `Price table v${whatIf.priceTableVersion}; ${whatIf.unpricedRequests} unpriced requests left out.`;
  return [header, ttlTable("By role", whatIf.byRole), ttlTable("By profile", whatIf.byProfile), causeTable(whatIf.byGapCause), [LIST_PRICE_CAVEAT, footer].join("\n")].join("\n\n") + "\n";
}

function ttlTable(title: string, rows: readonly CacheTtlBucket[]): string {
  const head = ["key", "sessions", "requests", "reprice saving", "rebuilds", "rebuild cost", "net", "net per session", "1h replay saving", "5m", "no-cache net", "no-cache"];
  const cells = rows.map((b) => [b.key, b.sessions, b.requests, usd(b.repriceSavingUsd), b.rebuilds, usd(b.rebuildCostUsd), usd(b.netSavingUsd), usd(b.netPerSessionUsd), usd(b.reverseSavingUsd), b.fiveMinuteLoses ? "loss" : "saves", usd(b.noCacheNetUsd), b.noCacheCheaper ? "no-cache" : "cache"]);
  return table(title, head, cells);
}

function causeTable(rows: CacheTtlWhatIf["byGapCause"]): string {
  return table("By gap cause", ["cause", "rebuilds", "rebuild tokens", "rebuild cost"], rows.map((c) => [c.cause, c.rebuilds, c.rebuildTokens, usd(c.rebuildCostUsd)]));
}
