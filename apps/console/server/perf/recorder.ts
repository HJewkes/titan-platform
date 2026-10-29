import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RpcSample } from "@titan-design/daemon";

/** One logged call. Name, timing, size and status only: never arguments, ids or the body. */
interface RpcRow {
  t: number;
  kind: "rpc";
  name: string;
  ms: number;
  bytes: number;
  status: number;
}

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

type SummaryWindow = "15m" | "24h";

export interface PerfRecorder {
  record(sample: RpcSample): void;
  summary(window: SummaryWindow): Promise<RpcStats[]>;
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
  const byName = new Map<string, RpcRow[]>();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
  return [...byName].map(([name, group]) => {
    const times = group.map((row) => row.ms).sort((a, b) => a - b);
    const sizes = group.map((row) => row.bytes).sort((a, b) => a - b);
    return {
      name,
      count: group.length,
      errors: group.filter((row) => row.status >= 400).length,
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

export function createPerfRecorder(options: PerfRecorderOptions): PerfRecorder {
  const { dir, now = Date.now, ringSize = 2000, flushMs = 5000, flushRows = 200, retentionDays = 7 } = options;
  const ring: RpcRow[] = [];
  const log = createBatchWriter(dir, flushMs, flushRows);
  const pruned = pruneOldLogs(dir, now(), retentionDays).catch(() => {});

  return {
    record(sample) {
      const row: RpcRow = { t: now(), kind: "rpc", name: sample.name, ms: sample.ms, bytes: sample.bytes, status: sample.status };
      ring.push(row);
      if (ring.length > ringSize) ring.shift();
      log.add(row);
    },
    async summary(window) {
      const since = now() - WINDOW_MS[window];
      if (window === "15m") return statsOf(ring.filter((row) => row.t >= since));
      await log.flush();
      return statsOf((await readLogs(dir, since)).filter((row) => row.t >= since));
    },
    flush: log.flush,
    async close() {
      await Promise.all([pruned, log.stop()]);
    },
  };
}

/** Buffers rows and appends them to the day files every `flushMs` or once `flushRows` wait; a failed write drops that batch. */
function createBatchWriter(dir: string, flushMs: number, flushRows: number) {
  let pending: RpcRow[] = [];
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
    add(row: RpcRow): void {
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

async function writeBatch(dir: string, batch: readonly RpcRow[]): Promise<void> {
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

async function readLogs(dir: string, since: number): Promise<RpcRow[]> {
  const firstDay = new Date(since).toISOString().slice(0, 10);
  const wanted = (await logFiles(dir)).filter(({ day }) => day >= firstDay);
  const texts = await Promise.all(wanted.map(({ file }) => readFile(path.join(dir, file), "utf8").catch(() => "")));
  return texts.flatMap((text) => text.split("\n").flatMap(parseRow));
}

function parseRow(line: string): RpcRow[] {
  if (line === "") return [];
  try {
    return [JSON.parse(line) as RpcRow];
  } catch {
    return [];
  }
}

async function pruneOldLogs(dir: string, t: number, retentionDays: number): Promise<void> {
  const oldest = new Date(t - retentionDays * DAY_MS).toISOString().slice(0, 10);
  const stale = (await logFiles(dir)).filter(({ day }) => day < oldest);
  await Promise.all(stale.map(({ file }) => rm(path.join(dir, file), { force: true })));
}
