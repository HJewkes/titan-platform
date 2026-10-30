import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AUTONOMY_DIR_UNSET, type CoordinatorRoots } from "./config-surfaces/coordinator.js";
import { dayUsage, dayWindow, perDayGuard, type DayWindow, type PoolReading } from "./coord-day.js";

const DAY_MS = 86_400_000;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const paceRow = z
  .object({
    pool: z.string(),
    sevenDay: z.number(),
    ageSeconds: z.number(),
    stale: z.boolean(),
    resetsAt: z.number(),
    target: z.number(),
    level: z.string(),
    members: z.array(z.string()).optional(),
  })
  .passthrough();
const paceDoc = z.object({ pools: z.record(z.string(), z.unknown()) }).passthrough();

const accountResult = z.object({
  pool: z.string(),
  members: z.array(z.string()),
  current: z.number().nullable(),
  beforeToday: z.number().nullable(),
  today: z.number().nullable(),
  reserveLine: z.number().nullable(),
  target: z.number().nullable(),
  level: z.string().nullable(),
  perDayGuard: z.number().nullable(),
  resetsAt: z.number().nullable(),
  ageSeconds: z.number().nullable(),
  stale: z.boolean().nullable(),
  error: z.string().optional(),
});
type PoolAccount = z.infer<typeof accountResult>;

export const poolsResult = z.object({ date: z.string(), from: z.string(), to: z.string(), accounts: z.array(accountResult), gaps: z.array(z.string()) });
type PoolsResult = z.infer<typeof poolsResult>;

interface CharterPool {
  reserve: number | null;
  perDay: number | null;
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

async function readCharterPools(autonomyDir: string): Promise<Map<string, CharterPool>> {
  const text = await readFile(path.join(autonomyDir, "charter.md"), "utf8");
  const front = FRONT_MATTER.exec(text);
  const data = front === null ? null : (parse(front[1]!) as { pools?: Record<string, Record<string, unknown> | null> } | null);
  const pools = new Map<string, CharterPool>();
  for (const [name, limits] of Object.entries(data?.pools ?? {})) pools.set(name, { reserve: numberOrNull(limits?.reserve_seven_day), perDay: numberOrNull(limits?.per_day_points) });
  return pools;
}

async function readReadings(agentChatDir: string): Promise<Map<string, PoolReading[]>> {
  const text = await readFile(path.join(agentChatDir, "pool-readings.jsonl"), "utf8");
  const byPool = new Map<string, PoolReading[]>();
  for (const line of text.split("\n")) {
    const row = parseRow(line);
    if (row !== null) byPool.set(row.pool, [...(byPool.get(row.pool) ?? []), row.reading]);
  }
  return byPool;
}

const readingRow = z.object({ ts: z.number(), pool: z.string(), seven_day: z.number(), resets_at: z.number(), rolled: z.literal(true).optional() });

/** A line that does not parse is skipped: the watchdog appends, so a torn last line is expected. */
function parseRow(line: string): { pool: string; reading: PoolReading } | null {
  if (line === "") return null;
  try {
    const row = readingRow.safeParse(JSON.parse(line));
    if (!row.success) return null;
    const { ts, pool, seven_day, resets_at, rolled } = row.data;
    return { pool, reading: { ts: ts * 1000, sevenDay: seven_day, resetsAt: resets_at * 1000, ...(rolled && { rolled }) } };
  } catch {
    return null;
  }
}

const failed = (what: string, error: unknown): string => `${what}: ${error instanceof Error ? error.message : String(error)}`;

async function attempt<T>(what: string, gaps: string[], read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    gaps.push(failed(what, (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : error));
    return null;
  }
}

/**
 * agent-chat's `pace.ts` computes this line as `100 - reserve * (8 - day) / 7`. It is repeated here as a display value
 * only, since pace.json carries the glide target but not the reserve line.
 */
function reserveLineOf(reserve: number | null, resetsAt: number, now: number): number | null {
  if (reserve === null) return null;
  const day = Math.min(7, Math.floor((now - (resetsAt - 7 * DAY_MS)) / DAY_MS) + 1);
  return 100 - (reserve * (8 - day)) / 7;
}

function errorAccount(pool: string, members: string[], error: string): PoolAccount {
  return { pool, members, current: null, beforeToday: null, today: null, reserveLine: null, target: null, level: null, perDayGuard: null, resetsAt: null, ageSeconds: null, stale: null, error };
}

interface Inputs {
  window: DayWindow;
  now: number;
  charter: Map<string, CharterPool> | null;
  readings: Map<string, PoolReading[]> | null;
}

function accountOf(row: z.infer<typeof paceRow>, { window, now, charter, readings }: Inputs): PoolAccount {
  const members = row.members ?? [row.pool];
  const history = readings === null ? null : dayUsage(readings.get(row.pool) ?? [], row.sevenDay, window, row.resetsAt);
  const perDays = members.map((member) => charter?.get(member)?.perDay).filter((value): value is number => typeof value === "number");
  // The account is shared by its members, so the tightest of their limits binds.
  const smallest = perDays.length === 0 ? null : Math.min(...perDays);
  return {
    pool: row.pool, members, current: row.sevenDay, beforeToday: history?.beforeToday ?? null, today: history?.today ?? null,
    reserveLine: reserveLineOf(charter?.get(row.pool)?.reserve ?? null, row.resetsAt, now), target: row.target, level: row.level,
    perDayGuard: history === null ? null : perDayGuard(history.beforeToday, smallest),
    resetsAt: row.resetsAt, ageSeconds: row.ageSeconds, stale: row.stale,
  };
}

async function readPace(agentChatDir: string): Promise<z.infer<typeof paceRow>[]> {
  const doc = paceDoc.parse(JSON.parse(await readFile(path.join(agentChatDir, "pace.json"), "utf8")));
  return Object.values(doc.pools).map((row) => paceRow.parse(row));
}

interface PoolsOptions {
  roots: CoordinatorRoots | undefined;
  dayStart: string;
  now: number;
  date?: string;
}

/** One entry per pace.json account; a missing pace.json gives every charter account an error and never throws. */
export async function readPools({ roots, dayStart, now, date }: PoolsOptions): Promise<PoolsResult> {
  const window = dayWindow(now, dayStart, date);
  const head = { date: window.date, from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() };
  if (roots === undefined) return { ...head, accounts: [], gaps: ["coordinator roots: not configured"] };
  const gaps: string[] = [];
  const charter = roots.autonomyDir === null ? (gaps.push(AUTONOMY_DIR_UNSET), null) : await attempt("charter.md", gaps, () => readCharterPools(roots.autonomyDir!));
  const readings = await attempt("pool-readings.jsonl", gaps, () => readReadings(roots.agentChatDir));
  const paceGaps: string[] = [];
  const pace = await attempt("pace.json", paceGaps, () => readPace(roots.agentChatDir));
  if (pace === null) {
    const error = paceGaps[0] ?? "pace.json: unreadable";
    return { ...head, accounts: [...(charter?.keys() ?? [])].map((pool) => errorAccount(pool, [pool], error)), gaps: [...gaps, error] };
  }
  return { ...head, accounts: pace.map((row) => accountOf(row, { window, now, charter, readings })), gaps };
}
