import { execFile } from "node:child_process";
import { PRICE_TABLE_VERSION } from "@titan-design/agent-protocol/pricing";
import type { GhExec, GhResult } from "@titan-design/github";
import { z } from "zod";
import type { DigestItem } from "../../digest.js";
import type { DayWindow } from "./session-source.js";

/** Runs a local read-only CLI (`active-work`, `titan-factory`); a test passes a fake answering with fixed JSON. */
export type CliRun = (argv: readonly string[]) => Promise<GhResult>;

export const execCli: CliRun = (argv) =>
  new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code === 127 ? error.message : "")) });
    });
  });

const CostSchema = z.object({
  data: z.object({
    priceTableVersion: z.number().int().nullable(),
    totals: z.object({ costUsd: z.number(), sessions: z.number().int() }),
    byAccount: z.array(z.object({ key: z.string().min(1), costUsd: z.number() })),
  }),
});
type Cost = z.infer<typeof CostSchema>["data"];

const StageSchema = z.object({ stage: z.string().min(1), runs: z.number().int(), medianMinutes: z.number(), p90Minutes: z.number() });
const GateWaitSchema = z.object({ kind: z.string().min(1), gates: z.number().int(), medianHours: z.number(), maxHours: z.number() });
const ShepherdStatsSchema = z.object({
  ownerFriction: z.array(z.object({ day: z.string(), ownerTouches: z.number().int(), kinds: z.array(GateWaitSchema) })),
  stageTimes: z.array(z.object({ repo: z.string(), week: z.string(), stages: z.array(StageSchema) })),
});
type ShepherdStats = z.infer<typeof ShepherdStatsSchema>;

/** What a stats read needs beyond the day: the runners, the repos merges are counted over, and the day's merges. */
export interface StatsInputs {
  run: CliRun;
  gh: GhExec;
  repos: readonly string[];
  window: DayWindow;
  merged: number;
  /** Tasks that became owner-gated in the window, from the task snapshot. */
  ownerGated: number;
}

export interface StatsResult {
  items: DigestItem[];
  notes: string[];
}

const TREND_DAYS = 7;
const DAY_MS = 86_400_000;

async function readJson<T>(read: () => Promise<GhResult>, schema: z.ZodType<T>, what: string): Promise<T> {
  const result = await read();
  if (result.code !== 0) throw new Error(`${what} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  return schema.parse(JSON.parse(result.stdout));
}

const minerCost = (run: CliRun, window: DayWindow) =>
  readJson(() => run(["active-work", "miner", "cost", "--since", window.since, "--until", window.until, "--json"]), CostSchema, "active-work miner cost").then((cost) => cost.data);

const shepherdStats = (run: CliRun, from: string, to: string) =>
  readJson(() => run(["titan-factory", "shepherd", "stats", "--from", from, "--to", to, "--json"]), ShepherdStatsSchema, "titan-factory shepherd stats");

// Shepherd counts a run's stage times only when its last stage ended inside the asked range, so week medians need
// the week asked for, Monday through the day.
export function isoWeekMonday(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

const mergedOn = async (gh: GhExec, repos: readonly string[], day: string) =>
  (await readJson(() => gh(["search", "prs", ...repos.flatMap((repo) => ["--repo", repo]), "--merged-at", day, "--limit", "1000", "--json", "number"]), z.array(z.unknown()), "gh search prs")).length;

// Spoken totals are whole dollars: the claims check reads a standalone integer, and "$1,234.56" splits into three.
const dollars = (usd: number) => `$${Math.round(usd)}`;

function stat(id: string, title: string, summary: string, window: DayWindow, priority?: string): DigestItem {
  return { id, kind: "stat", title, summary, at: window.since, ...(priority ? { priority } : {}) };
}

// The session graph prices requests when read, at the rates its own price table holds; a CLI built on an older
// table quotes older rates, so the facts say which table priced them.
function pricedAt(version: number | null, current: number): string {
  if (version === null) return "no price table";
  return version === current ? `priced at price table v${version}` : `priced at price table v${version}, not the current v${current}`;
}

/** `stat/spend`, one `stat/spend/<account>` per account that spent, and `stat/cost-per-pr` over the day's merges. */
export function spendItems(cost: Cost, merged: number, window: DayWindow, current: number = PRICE_TABLE_VERSION): DigestItem[] {
  const priced = pricedAt(cost.priceTableVersion, current);
  const accounts = cost.byAccount.filter((row) => row.costUsd > 0).map((row) => stat(`stat/spend/${row.key}`, `${dollars(row.costUsd)} spent on account ${row.key}`, priced, window));
  const perPrTitle = `$${(cost.totals.costUsd / merged).toFixed(2)} spent per merged PR`;
  const perPr = merged > 0 ? [stat("stat/cost-per-pr", perPrTitle, `${dollars(cost.totals.costUsd)} over ${merged} merged PRs`, window, "P1")] : [];
  return [stat("stat/spend", `${dollars(cost.totals.costUsd)} spent across ${cost.totals.sessions} sessions`, priced, window, "P1"), ...accounts, ...perPr];
}

export interface TrendPoint {
  day: string;
  usd?: number;
  merged?: number;
}

/** `stat/trend`: spend and merges per day, each point labelled `MM-DD: number` so a chart view can draw it. */
export function trendItem(points: readonly TrendPoint[], window: DayWindow): DigestItem {
  const series = (pick: (point: TrendPoint) => number | undefined) =>
    points.flatMap((point) => (pick(point) === undefined ? [] : [`${point.day.slice(5)}: ${Math.round(pick(point)!)}`])).join(", ");
  return stat("stat/trend", `Spend and merges per day over ${points.length} days`, `dollars per day: ${series((p) => p.usd)} · merges per day: ${series((p) => p.merged)}`, window, "P1");
}

/** Owner touches and gate waits for the day, stage medians for its ISO week, and tasks newly owner-gated. */
export function slowdownItems(stats: ShepherdStats, day: string, ownerGated: number, window: DayWindow): DigestItem[] {
  const friction = stats.ownerFriction.find((row) => row.day === day);
  const touches = stat("slow/owner-touches", `${friction?.ownerTouches ?? 0} owner touches on Shepherd gates`, friction ? `${friction.kinds.length} gate kinds waited on the owner` : "no Shepherd gate waited on the owner", window);
  const waits = (friction?.kinds ?? []).map((row) =>
    stat(`slow/gate-wait/${row.kind}`, `${row.kind} gates waited a median ${row.medianHours} hours on the owner`, `${row.gates} gates, the longest ${row.maxHours} hours`, window));
  const stages = [...new Set(stats.stageTimes.flatMap((repo) => repo.stages.map((row) => row.stage)))].map((name) => {
    const line = (repo: string, row: z.infer<typeof StageSchema>) => `${repo} median ${row.medianMinutes} min, p90 ${row.p90Minutes} min over ${row.runs} runs`;
    const rows = stats.stageTimes.flatMap((repo) => repo.stages.filter((row) => row.stage === name).map((row) => line(repo.repo, row)));
    return stat(`slow/stage/${name}`, `${name} stage this week (${stats.stageTimes[0]?.week ?? "this ISO week"})`, rows.join("; "), window);
  });
  return [touches, ...waits, ...stages, stat("slow/owner-gated", `${ownerGated} ${ownerGated === 1 ? "task" : "tasks"} became owner-gated`, "from the task snapshot", window)];
}

// The six days before the window; the window itself is read once, for spend and for the trend's last point.
const priorDays = (window: DayWindow) =>
  Array.from({ length: TREND_DAYS - 1 }, (_, i) => {
    const since = new Date(Date.parse(window.since) - (TREND_DAYS - 1 - i) * DAY_MS);
    return { since: since.toISOString(), until: new Date(since.getTime() + DAY_MS).toISOString() };
  });

async function settle<T>(read: Promise<T>, notes: string[]): Promise<T | undefined> {
  try {
    return await read;
  } catch (error) {
    notes.push(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function priorPoints(inputs: StatsInputs, notes: string[]): Promise<TrendPoint[]> {
  return Promise.all(priorDays(inputs.window).map(async (window) => {
    const day = window.since.slice(0, 10);
    const [cost, merged] = await Promise.all([settle(minerCost(inputs.run, window), notes), settle(mergedOn(inputs.gh, inputs.repos, day), notes)]);
    return { day, ...(cost ? { usd: cost.totals.costUsd } : {}), ...(merged === undefined ? {} : { merged }) };
  }));
}

/**
 * Spend, its split by account, cost per merged PR, a seven-day trend and the day's slowdowns, read over the
 * `active-work`, `titan-factory` and `gh` CLIs. A CLI that fails costs its facts and leaves a note; the gather goes on.
 */
export async function statsItems(inputs: StatsInputs): Promise<StatsResult> {
  const notes: string[] = [];
  const day = inputs.window.since.slice(0, 10);
  const [today, prior, dayStats, weekStats] = await Promise.all([
    settle(minerCost(inputs.run, inputs.window), notes),
    priorPoints(inputs, notes),
    settle(shepherdStats(inputs.run, day, day), notes),
    settle(shepherdStats(inputs.run, isoWeekMonday(day), day), notes),
  ]);
  const stats = dayStats && { ownerFriction: dayStats.ownerFriction, stageTimes: weekStats?.stageTimes ?? [] };
  const points = [...prior, { day, merged: inputs.merged, ...(today ? { usd: today.totals.costUsd } : {}) }];
  if (today && today.priceTableVersion !== PRICE_TABLE_VERSION) notes.push(`spend is ${pricedAt(today.priceTableVersion, PRICE_TABLE_VERSION)}`);
  const items = [
    ...(today ? spendItems(today, inputs.merged, inputs.window) : []),
    trendItem(points, inputs.window),
    ...(stats ? slowdownItems(stats, day, inputs.ownerGated, inputs.window) : []),
  ];
  return { items, notes: [...new Set(notes)].map((note) => `stats: ${note}`) };
}
