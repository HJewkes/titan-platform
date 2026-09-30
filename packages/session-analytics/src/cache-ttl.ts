import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { GAP_BANDS, gapBand } from "./bands.js";
import { readSessionContexts, type ReportWindow } from "./cost-report-queries.js";
import { resolveWindow, tagSessions, type CostReportOptions } from "./cost-report.js";
import { PRICE_TABLE, PRICE_TABLE_VERSION, findPrice, type PriceRow } from "./prices.js";
import { LIST_PRICE_CAVEAT, table, usd } from "./render-text.js";

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
  /** Milliseconds since the session's previous request; null for its first. */
  gapMs: number | null;
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
};
const bucketSchema = z.object({ key: z.string(), ...effectFields, fiveMinuteLoses: z.boolean() });

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
});

export type CacheTtlWhatIf = z.infer<typeof cacheTtlWhatIfSchema>;
export type CacheTtlBucket = z.infer<typeof bucketSchema>;

interface RequestEffect {
  sessionId: string;
  write1hTokens: number;
  repriceSavingUsd: number;
  rebuildTokens: number;
  rebuildCostUsd: number;
}

/** Q3: what each role and profile would have paid with `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` instead of 1h. */
export function cacheTtlWhatIf(rows: readonly TtlRequestRow[], prices: readonly PriceRow[] = PRICE_TABLE): CacheTtlWhatIf {
  const effects = new Map<TtlRequestRow, RequestEffect>();
  for (const row of rows) {
    const price = findPrice(row.model, row.ts, prices);
    if (price) effects.set(row, requestEffect(row, price));
  }
  const priced = [...effects.keys()];
  const byRole = buckets(priced, effects, (row) => row.role);
  return {
    priceTableVersion: PRICE_TABLE_VERSION,
    rebuildGapBands: [...REBUILD_GAP_BANDS],
    totals: sumEffects([...effects.values()]),
    unpricedRequests: rows.length - priced.length,
    byRole,
    byProfile: buckets(priced, effects, (row) => row.profile),
    lossRoles: byRole.filter((bucket) => bucket.fiveMinuteLoses).map((bucket) => bucket.key),
  };
}

function requestEffect(row: TtlRequestRow, price: PriceRow): RequestEffect {
  const band = row.gapMs === null ? null : gapBand(row.gapMs);
  const rebuildTokens = band !== null && REBUILD_GAP_BANDS.includes(band) ? row.cacheReadTokens : 0;
  return {
    sessionId: row.sessionId,
    write1hTokens: row.cacheWrite1hTokens,
    repriceSavingUsd: (row.cacheWrite1hTokens * (price.cacheWrite1h - price.cacheWrite5m)) / MTOK,
    rebuildTokens,
    rebuildCostUsd: (rebuildTokens * (price.cacheWrite5m - price.cacheRead)) / MTOK,
  };
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
      return { key, ...totals, fiveMinuteLoses: totals.netSavingUsd < 0 };
    })
    .sort((a, b) => b.netSavingUsd - a.netSavingUsd || a.key.localeCompare(b.key));
}

const IN_WINDOW = "(@since IS NULL OR ts >= @since) AND (@until IS NULL OR ts < @until)";

// The miner leaves `gap_ms` null, so the gap falls back to the session's previous request, even one before the window.
const TTL_ROWS = `
  WITH member AS (SELECT DISTINCT session_id FROM request_dedup WHERE ${IN_WINDOW}),
  timed AS (
    SELECT session_id, model, ts, cache_read_tokens, cache_creation_1h, gap_ms,
      LAG(ts) OVER (PARTITION BY session_id, is_sidechain ORDER BY ts, request_id) AS previous_ts
    FROM request_dedup WHERE session_id IN member
  )
  SELECT session_id AS sessionId, model, ts, cache_read_tokens AS cacheReadTokens, cache_creation_1h AS cacheWrite1hTokens,
    COALESCE(gap_ms, CAST(ROUND((julianday(ts) - julianday(previous_ts)) * 86400000) AS INTEGER)) AS gapMs
  FROM timed WHERE ${IN_WINDOW}`;

/** Reads the graph and never writes it; roles are the cost report's. */
export function cacheTtlReport(db: Db, options: CostReportOptions = {}, prices: readonly PriceRow[] = PRICE_TABLE): CacheTtlWhatIf {
  const window = resolveWindow(options);
  return { window, ...cacheTtlWhatIf(readTtlRows(db, window), prices) };
}

export function readTtlRows(db: Db, window: ReportWindow): TtlRequestRow[] {
  const rows = db.prepare(TTL_ROWS).all(window) as Omit<TtlRequestRow, "role" | "profile">[];
  const contexts = readSessionContexts(db, [...new Set(rows.map((row) => row.sessionId))]);
  const tags = tagSessions(contexts);
  return rows.map((row) => ({
    ...row,
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
  ].join("\n");
  const footer = `Price table v${whatIf.priceTableVersion}; ${whatIf.unpricedRequests} unpriced requests left out.`;
  return [header, ttlTable("By role", whatIf.byRole), ttlTable("By profile", whatIf.byProfile), [LIST_PRICE_CAVEAT, footer].join("\n")].join("\n\n") + "\n";
}

function ttlTable(title: string, rows: readonly CacheTtlBucket[]): string {
  const head = ["key", "sessions", "requests", "reprice saving", "rebuilds", "rebuild cost", "net", "net per session", "5m"];
  const cells = rows.map((b) => [b.key, b.sessions, b.requests, usd(b.repriceSavingUsd), b.rebuilds, usd(b.rebuildCostUsd), usd(b.netSavingUsd), usd(b.netPerSessionUsd), b.fiveMinuteLoses ? "loss" : "saves"]);
  return table(title, head, cells);
}
