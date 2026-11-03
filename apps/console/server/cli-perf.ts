/**
 * `titan-console perf waits [--top <n>] [--window <15m|24h|7d>] [--json]`: the commands the owner waited on longest,
 * read from the perf day files, so a coordinator can file the slowest as tasks without a running daemon.
 */
import path from "node:path";
import type { ConsoleConfig } from "./config.js";
import { WINDOW_MS, readWaitRows, type SummaryWindow } from "./perf/recorder.js";
import { rankWaits, type WaitStats } from "./perf/waits.js";

export const PERF_USAGE = `       titan-console perf waits [--top <n>] [--window <15m|24h|7d>] [--json]
                                        rank the commands the owner waited on behind a spinner,
                                        skeleton or busy button by total owner seconds, with p50,
                                        p95 and waits past the command's budget; default top 10, 24h`;

interface PerfWaitsArgs {
  top: number;
  window: SummaryWindow;
  json: boolean;
}

const WINDOWS = new Set<string>(["15m", "24h", "7d"]);
const isWindow = (value: string): value is SummaryWindow => WINDOWS.has(value);
const COUNT = /^[1-9]\d{0,3}$/;

/** `perf waits` with each flag at most once, in any order; null for anything else. */
export function perfWaitsArgs(argv: readonly string[]): PerfWaitsArgs | null {
  if (argv[0] !== "perf" || argv[1] !== "waits") return null;
  const parsed: PerfWaitsArgs = { top: 10, window: "24h", json: false };
  const seen = new Set<string>();
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1] ?? "";
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === "--json") parsed.json = true;
    else if (flag === "--top" && COUNT.test(value)) parsed.top = Number(value);
    else if (flag === "--window" && isWindow(value)) parsed.window = value;
    else return null;
    if (flag !== "--json") i += 1;
  }
  return parsed;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** One line per command: names and numbers only, so a line can go into a task as it is. */
export function waitLine(stats: WaitStats, rank: number): string {
  const breach = stats.overBudget > 0 ? `, ${stats.overBudget} over the ${stats.budgetMs} ms budget` : "";
  return `${rank}. ${stats.command}: ${seconds(stats.ownerMs)} s over ${stats.waits} waits, p50 ${Math.round(stats.p50)} ms, p95 ${Math.round(stats.p95)} ms, ${stats.cold} cold, ${stats.mutation} on a write${breach}`;
}

export function formatWaits(ranked: readonly WaitStats[], { top, window }: Pick<PerfWaitsArgs, "top" | "window">): string {
  if (ranked.length === 0) return `no waits recorded in the last ${window}`;
  return [`owner waits, last ${window}, most owner time first:`, ...ranked.slice(0, top).map((stats, i) => waitLine(stats, i + 1))].join("\n");
}

export async function perfWaitsCli(config: Pick<ConsoleConfig, "stateDir">, args: PerfWaitsArgs, now: number = Date.now()): Promise<string> {
  const rows = await readWaitRows(path.join(config.stateDir, "perf"), now - WINDOW_MS[args.window]);
  const ranked = rankWaits(rows);
  return args.json ? JSON.stringify({ window: args.window, waits: ranked.slice(0, args.top) }) : formatWaits(ranked, args);
}
