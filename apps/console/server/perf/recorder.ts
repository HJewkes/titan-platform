import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RpcSample } from "@titan-design/daemon";
import { z } from "zod";

/** One logged call. Name, timing, size and status only: never arguments, ids or the body. */
const rpcRow = z.object({ t: z.number(), kind: z.literal("rpc"), name: z.string(), ms: z.number(), bytes: z.number(), status: z.number() });
type RpcRow = z.infer<typeof rpcRow>;
const upstreamOutcome = z.enum(["ok", "timeout", "error"]);
const upstreamRow = z.object({ t: z.number(), kind: z.literal("upstream"), name: z.string(), ms: z.number(), bytes: z.number(), outcome: upstreamOutcome });
type UpstreamRow = z.infer<typeof upstreamRow>;
const logRow = z.discriminatedUnion("kind", [rpcRow, upstreamRow]);

/** One call to an upstream daemon. `name` is `<upstream>:<command>`, taken from the RPC path. */
export type UpstreamSample = Omit<UpstreamRow, "t" | "kind">;

/** What the browser measured: a route's time to first data, one query's time, or how many rows it had to drop. Names and numbers only. */
export type ClientRow =
  | { kind: "route"; view: string; detail: boolean; ms: number; queries: number }
  | { kind: "query"; command: string; ms: number; ok: boolean; fromCache: boolean }
  | { kind: "dropped"; count: number };
type LogRow = z.infer<typeof logRow> | (ClientRow & { t: number });

interface PerfRecorderOptions {
  /** `stateDir/perf`; created on first flush. */
  dir: string;
  now?: () => number;
  ringSize?: number;
  flushMs?: number;
  flushRows?: number;
  retentionDays?: number;
}

export interface RpcStats {
  name: string;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
  bytesP50: number;
  bytesMax: number;
}

type UpstreamStats = RpcStats & { timeouts: number };

type SummaryWindow = "15m" | "24h";

export interface PerfRecorder {
  record(sample: RpcSample): void;
  /** Logs rows the browser reported; they join the day files but not the rpc summary. */
  recordClient(rows: readonly ClientRow[]): void;
  recordUpstream(sample: UpstreamSample): void;
  summary(window: SummaryWindow): Promise<RpcStats[]>;
  upstreams(window: SummaryWindow): Promise<(RpcStats & { timeouts: number })[]>;
  /** Writes what is buffered; resolves when it is on disk. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

const DAY_MS = 86_400_000;
const WINDOW_MS: Record<SummaryWindow, number> = { "15m": 15 * 60_000, "24h": DAY_MS };
const LOG_FILE = /^rpc-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Nearest rank: the 19th smallest of 20 samples is the p95. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

function statsOf(rows: readonly RpcRow[]): RpcStats[] {
  return groupStats(rows, (row) => row.status >= 400);
}

function upstreamStatsOf(rows: readonly UpstreamRow[]): UpstreamStats[] {
  const timeouts = (name: string) => rows.filter((row) => row.name === name && row.outcome === "timeout").length;
  return groupStats(rows, (row) => row.outcome !== "ok").map((stats) => ({ ...stats, timeouts: timeouts(stats.name) }));
}

function groupStats<R extends { name: string; ms: number; bytes: number }>(rows: readonly R[], failed: (row: R) => boolean): RpcStats[] {
  const byName = new Map<string, R[]>();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
  return [...byName].map(([name, group]) => {
    const times = group.map((row) => row.ms).sort((a, b) => a - b);
    const sizes = group.map((row) => row.bytes).sort((a, b) => a - b);
    return {
      name,
      count: group.length,
      errors: group.filter(failed).length,
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      max: times[times.length - 1]!,
      bytesP50: percentile(sizes, 0.5),
      bytesMax: sizes[sizes.length - 1]!,
    };
  });
}

function logName(t: number): string {
  return `rpc-${new Date(t).toISOString().slice(0, 10)}.jsonl`;
}

/** Server-side rows go to the bounded ring as well as the day files, so the 15m window never reads disk. */
function ringedLog(ringSize: number, log: { add(row: LogRow): void }): { ring: LogRow[]; keep(row: LogRow): void } {
  const ring: LogRow[] = [];
  return {
    ring,
    keep(row) {
      ring.push(row);
      if (ring.length > ringSize) ring.shift();
      log.add(row);
    },
  };
}

export function createPerfRecorder(options: PerfRecorderOptions): PerfRecorder {
  const { dir, now = Date.now, ringSize = 2000, flushMs = 5000, flushRows = 200, retentionDays = 7 } = options;
  const log = createBatchWriter(dir, flushMs, flushRows);
  const { ring, keep } = ringedLog(ringSize, log);
  const pruned = pruneOldLogs(dir, now(), retentionDays).catch(() => {});

  const rowsIn = (window: SummaryWindow) => windowRows(window, now() - WINDOW_MS[window], ring, log.flush, dir);

  return {
    record(sample) {
      keep({ t: now(), kind: "rpc", name: sample.name, ms: sample.ms, bytes: sample.bytes, status: sample.status });
    },
    recordUpstream(sample) {
      keep({ t: now(), kind: "upstream", name: sample.name, ms: sample.ms, bytes: sample.bytes, outcome: sample.outcome });
    },
    recordClient(rows) {
      for (const row of rows) log.add({ ...row, t: now() });
    },
    async summary(window) {
      return statsOf((await rowsIn(window)).filter((row): row is RpcRow => row.kind === "rpc"));
    },
    async upstreams(window) {
      return upstreamStatsOf((await rowsIn(window)).filter((row): row is UpstreamRow => row.kind === "upstream"));
    },
    flush: log.flush,
    async close() {
      await Promise.all([pruned, log.stop()]);
    },
  };
}

/** The last 15 minutes come from the ring; a longer window reads the day files after what is buffered is written. */
async function windowRows(window: SummaryWindow, since: number, ring: readonly LogRow[], flush: () => Promise<void>, dir: string): Promise<LogRow[]> {
  if (window === "15m") return ring.filter((row) => row.t >= since);
  await flush();
  return (await readLogs(dir, since)).filter((row) => row.t >= since);
}

/** Buffers rows and appends them to the day files every `flushMs` or once `flushRows` wait; a failed write drops that batch. */
function createBatchWriter(dir: string, flushMs: number, flushRows: number) {
  let pending: LogRow[] = [];
  let writing: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return writing;
    writing = writing.then(() => writeBatch(dir, batch)).catch(() => {});
    return writing;
  };
  const timer = setInterval(() => void flush(), flushMs);
  timer.unref();
  return {
    add(row: LogRow): void {
      pending.push(row);
      if (pending.length >= flushRows) void flush();
    },
    flush,
    async stop(): Promise<void> {
      clearInterval(timer);
      await flush();
    },
  };
}

async function writeBatch(dir: string, batch: readonly LogRow[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const byFile = new Map<string, string>();
  for (const row of batch) byFile.set(logName(row.t), `${byFile.get(logName(row.t)) ?? ""}${JSON.stringify(row)}\n`);
  for (const [file, text] of byFile) await appendFile(path.join(dir, file), text);
}

async function logFiles(dir: string): Promise<{ file: string; day: string }[]> {
  const names = await readdir(dir).catch(() => []);
  return names.flatMap((file) => {
    const day = LOG_FILE.exec(file)?.[1];
    return day === undefined ? [] : [{ file, day }];
  });
}

async function readLogs(dir: string, since: number): Promise<LogRow[]> {
  const firstDay = new Date(since).toISOString().slice(0, 10);
  const wanted = (await logFiles(dir)).filter(({ day }) => day >= firstDay);
  const texts = await Promise.all(wanted.map(({ file }) => readFile(path.join(dir, file), "utf8").catch(() => "")));
  return texts.flatMap((text) => text.split("\n").flatMap(parseRow));
}

function parseRow(line: string): LogRow[] {
  try {
    const parsed = logRow.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
}

async function pruneOldLogs(dir: string, t: number, retentionDays: number): Promise<void> {
  const oldest = new Date(t - retentionDays * DAY_MS).toISOString().slice(0, 10);
  const stale = (await logFiles(dir)).filter(({ day }) => day < oldest);
  await Promise.all(stale.map(({ file }) => rm(path.join(dir, file), { force: true })));
}
