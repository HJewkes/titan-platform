import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dateArg, DEFAULT_DAY_START, dayWindow, type DayWindow } from "./coord-day.js";
import { readCommand } from "./owner-guard.js";
import type { ShepherdSource } from "./shepherd.js";

const prRef = z.object({ repo: z.string(), number: z.number().int(), task: z.string(), initiative: z.string(), url: z.string() });

const digestSchema = z.object({
  v: z.literal(1),
  date: z.string(),
  builtAt: z.string(),
  prSetHash: z.string(),
  groups: z.array(
    z.object({
      initiative: z.string(),
      themes: z.array(z.object({ title: z.string(), summary: z.string(), prs: z.array(prRef) })),
      unsummarized: z.array(prRef),
    }),
  ),
});

const shippedResult = z.object({
  date: z.string(),
  built: z.boolean(),
  /** True when the digest was built for a different set of merged PRs than Shepherd lists now. */
  stale: z.boolean(),
  digest: digestSchema.nullable(),
  merged: z.array(prRef),
});

export type PrRef = z.infer<typeof prRef>;
export type ShippedDigest = z.infer<typeof digestSchema>;
type ShippedResult = z.infer<typeof shippedResult>;
/** What `coord.shipped` reads: the digest directory, and the local time a day starts at. */
export interface ShippedOptions {
  dir: string;
  dayStart?: string;
}

export type FinishedRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const DIGEST_MODE = 0o600;

const outcomeOf = z.object({ outcome: z.object({ kind: z.string() }).passthrough() }).passthrough();

function prRefOf(row: FinishedRow): PrRef | null {
  if (row.pr === null) return null;
  const slash = row.task.indexOf("/");
  return { repo: row.repo, number: row.pr, task: slash === -1 ? row.task : row.task.slice(slash + 1), initiative: slash === -1 ? "ungrouped" : row.task.slice(0, slash), url: `https://github.com/${row.repo}/pull/${row.pr}` };
}

const landedStep = z.object({ kind: z.literal("step"), stepId: z.literal("sh-landed"), completedAt: z.string() }).passthrough();

/** `phaseSince` trails the merge (the run's phase flips after the lander finishes), so a merge near a day edge needs the real time. */
const PHASE_TRAIL_SLACK_MS = 6 * 60 * 60 * 1000;

const isMerged = (row: FinishedRow): boolean => outcomeOf.safeParse(row).data?.outcome.kind === "merged";

/** A run's `sh-landed` time never changes once written, so each source reads a run's timeline at most once. */
const landedCache = new WeakMap<object, Map<string, number>>();

async function landedAt(shepherd: Pick<ShepherdSource, "timeline">, row: FinishedRow, known: Map<string, number>): Promise<number | undefined> {
  const cached = known.get(row.runId);
  if (cached !== undefined) return cached;
  const { entries } = await shepherd.timeline(row.repo, row.pr!).catch(() => ({ entries: [] as unknown[] }));
  const landed = entries.map((entry) => landedStep.safeParse(entry)).flatMap((parsed) => (parsed.success ? [Date.parse(parsed.data.completedAt)] : []));
  const time = landed.at(-1);
  if (time === undefined || Number.isNaN(time)) return undefined;
  known.set(row.runId, time);
  return time;
}

/**
 * When each merged run that could belong to the window landed, from its local timeline's `sh-landed` step; a run whose timeline
 * has no such step or cannot be read is left out, and bucketing falls back to its `phaseSince`.
 */
export async function mergeTimes(shepherd: Pick<ShepherdSource, "timeline">, rows: readonly FinishedRow[], window: DayWindow): Promise<Map<string, number>> {
  const known = landedCache.get(shepherd) ?? new Map<string, number>();
  landedCache.set(shepherd, known);
  const candidates = rows.filter((row) => row.pr !== null && isMerged(row) && Date.parse(row.phaseSince) >= window.from && Date.parse(row.phaseSince) < window.to + PHASE_TRAIL_SLACK_MS);
  const times = await Promise.all(candidates.map(async (row) => [row.runId, await landedAt(shepherd, row, known)] as const));
  return new Map(times.flatMap(([runId, time]) => (time === undefined ? [] : [[runId, time] as const])));
}

/** Shepherd's finished runs whose outcome is `merged` and whose merge time (`mergedAt`, else `phaseSince`) falls inside the window. */
export function mergedInWindow(rows: readonly FinishedRow[], window: DayWindow, mergedAt: ReadonlyMap<string, number> = new Map()): PrRef[] {
  return mergedRunsInWindow(rows, window, mergedAt).map(({ ref }) => ref);
}

/** The same runs with the row each came from, for a reader that joins on its branch. */
export function mergedRunsInWindow(rows: readonly FinishedRow[], window: DayWindow, mergedAt: ReadonlyMap<string, number> = new Map()): { row: FinishedRow; ref: PrRef }[] {
  return rows
    .filter((row) => {
      const when = mergedAt.get(row.runId) ?? Date.parse(row.phaseSince);
      return isMerged(row) && when >= window.from && when < window.to;
    })
    .flatMap((row) => {
      const ref = prRefOf(row);
      return ref === null ? [] : [{ row, ref }];
    });
}

export function prSetHash(prs: readonly PrRef[]): string {
  const keys = prs.map(({ repo, number }) => `${repo}#${number}`).sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

const digestPath = (dir: string, date: string): string => path.join(dir, `${date}.json`);

/** Null when there is no digest for the date or the file is not a v1 digest: the page then shows the merged list unbuilt. */
async function readDigest(dir: string, date: string): Promise<ShippedDigest | null> {
  const text = await readFile(digestPath(dir, date), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return digestSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Writes beside the target and renames over it, so a read never sees half a file. */
export async function writeDigest(dir: string, digest: ShippedDigest): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = digestPath(dir, digest.date);
  const staged = `${target}.${process.pid}.tmp`;
  await writeFile(staged, `${JSON.stringify(digestSchema.parse(digest), null, 2)}\n`, { mode: DIGEST_MODE });
  await rename(staged, target);
}

/** Reads Shepherd's finished list, the timelines of the runs near the window, and one file; it never calls GitHub or a model, which only `shipped build` does. */
export async function readShipped(shepherd: Pick<ShepherdSource, "list" | "timeline">, options: ShippedOptions, now: number, date?: string): Promise<ShippedResult> {
  const window = dayWindow(now, options.dayStart ?? DEFAULT_DAY_START, date);
  const finished = await shepherd.list("finished");
  const merged = mergedInWindow(finished, window, await mergeTimes(shepherd, finished, window));
  const digest = await readDigest(options.dir, window.date);
  return { date: window.date, built: digest !== null, stale: digest !== null && digest.prSetHash !== prSetHash(merged), digest, merged };
}

export function shippedCommands(shepherd: ShepherdSource, options: ShippedOptions, clock: () => number = Date.now) {
  return {
    "coord.shipped": readCommand({
      name: "coord.shipped",
      description: "The day's PRs merged through Shepherd with the cached theme digest, if one was built; stale when the merged set changed since",
      args: z.object({ date: dateArg }),
      result: shippedResult,
      run: ({ date }) => readShipped(shepherd, options, clock(), date),
    }),
  };
}
