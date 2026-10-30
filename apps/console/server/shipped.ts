import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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

type PrRef = z.infer<typeof prRef>;
export type ShippedDigest = z.infer<typeof digestSchema>;
type ShippedResult = z.infer<typeof shippedResult>;
interface DayWindow {
  date: string;
  from: number;
  to: number;
}

/** What `coord.shipped` reads: the digest directory, and the local time a day starts at. */
export interface ShippedOptions {
  dir: string;
  dayStart?: string;
}

type FinishedRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const DEFAULT_DAY_START = "07:00";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST_MODE = 0o600;

const outcomeOf = z.object({ outcome: z.object({ kind: z.string() }).passthrough() }).passthrough();

function isoDate(day: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** The local-time window of `date`, from its day start to the next one; without a date, the window that holds `now`. */
export function dayWindow(now: number, dayStart: string = DEFAULT_DAY_START, date?: string): DayWindow {
  const [hours = 0, minutes = 0] = dayStart.split(":").map(Number);
  const anchor = date === undefined ? new Date(now - (hours * 60 + minutes) * 60_000) : new Date(`${date}T12:00:00`);
  const [year, month, day] = [anchor.getFullYear(), anchor.getMonth(), anchor.getDate()];
  return { date: isoDate(anchor), from: new Date(year, month, day, hours, minutes).getTime(), to: new Date(year, month, day + 1, hours, minutes).getTime() };
}

function prRefOf(row: FinishedRow): PrRef | null {
  if (row.pr === null) return null;
  const slash = row.task.indexOf("/");
  return { repo: row.repo, number: row.pr, task: slash === -1 ? row.task : row.task.slice(slash + 1), initiative: slash === -1 ? "ungrouped" : row.task.slice(0, slash), url: `https://github.com/${row.repo}/pull/${row.pr}` };
}

/** Shepherd's finished runs whose outcome is `merged` and whose phase began inside the window; `phaseSince` is the merge time. */
export function mergedInWindow(rows: readonly FinishedRow[], window: DayWindow): PrRef[] {
  return rows
    .filter((row) => {
      const since = Date.parse(row.phaseSince);
      return outcomeOf.safeParse(row).data?.outcome.kind === "merged" && since >= window.from && since < window.to;
    })
    .flatMap((row) => prRefOf(row) ?? []);
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

/** Reads one list from Shepherd and one file; it never calls GitHub or a model, which only `shipped build` does. */
export async function readShipped(shepherd: Pick<ShepherdSource, "list">, options: ShippedOptions, now: number, date?: string): Promise<ShippedResult> {
  const window = dayWindow(now, options.dayStart, date);
  const merged = mergedInWindow(await shepherd.list("finished"), window);
  const digest = await readDigest(options.dir, window.date);
  return { date: window.date, built: digest !== null, stale: digest !== null && digest.prSetHash !== prSetHash(merged), digest, merged };
}

export function shippedCommands(shepherd: ShepherdSource, options: ShippedOptions, clock: () => number = Date.now) {
  return {
    "coord.shipped": readCommand({
      name: "coord.shipped",
      description: "The day's PRs merged through Shepherd with the cached theme digest, if one was built; stale when the merged set changed since",
      args: z.object({ date: z.string().regex(DATE, "must be YYYY-MM-DD").optional() }),
      result: shippedResult,
      run: ({ date }) => readShipped(shepherd, options, clock(), date),
    }),
  };
}
