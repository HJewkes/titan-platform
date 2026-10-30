/**
 * The blocker banner's read (TP-4388 c): what has waited on the owner longer than N hours, from three sources that are
 * already records. A deposit that carries `blocker`, an owner gate a live pinned run is pending on, and an unsatisfied
 * hold on such a run. The banner keeps no state; an item leaves it when its source closes. It reads the spool directly
 * and Shepherd's active rows through a cache, never `inbox.list`, whose budget is twenty times this one's.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { depositItemId, ownerItemDepositSchema } from "@titan-design/owner-queue";
import { MAX_DEPOSIT_BYTES, depositFileNames } from "@titan-design/owner-queue/spool";
import { DEFAULT_BLOCKER_HOURS } from "./blocker-hours.js";
import { openDepositNames, spoolNames } from "./inbox.js";
import { pinnedLive } from "./inbox-blocking.js";
import type { Invalidation } from "./invalidation.js";
import { readCommand } from "./owner-guard.js";
import { cachedRead, type CacheTimes } from "./read-cache.js";
import type { ShepherdSource } from "./shepherd.js";

type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const HOUR = 3_600_000;
const MAX_ITEMS = 5;
const MAX_SUMMARY = 120;
/** Shepherd's `SEAT_STEPS`, mirrored because the console cannot depend on titan-factory: a seat answers these, not the owner. */
const SEAT_STEPS: ReadonlySet<string> = new Set(["ci-failed", "sh-sent-back", "stuck-behind"]);
/** As the inbox's: short enough that a gate answered elsewhere leaves the banner soon. */
const BANNER_CACHE_TIMES: CacheTimes = { freshMs: 15_000, staleMs: 5 * 60_000 };

/** The fields of an open blocker deposit the banner shows. */
export interface SpoolBlocker {
  id: string;
  asker: string;
  summary: string;
  blocker: { since: string; blocks: string };
  expiresAt?: string;
}

const bannerBlocker = z.object({
  id: z.string(),
  source: z.enum(["blocker", "owner-gate", "owner-hold"]),
  summary: z.string(),
  blocks: z.string(),
  asker: z.string().optional(),
  /** Set only when the roster was read and the deposit's asker is not on it; the item still shows. */
  askerGone: z.literal(true).optional(),
  since: z.string(),
  ageHours: z.number(),
  link: z.string(),
});
type BannerBlocker = z.infer<typeof bannerBlocker>;

const bannerResult = z.object({ thresholdHours: z.number(), count: z.number().int(), items: z.array(bannerBlocker), gaps: z.array(z.string()) });
type BannerResult = z.infer<typeof bannerResult>;

export interface BannerInput {
  spoolItems: readonly SpoolBlocker[];
  rows: readonly WatchRow[];
  /** Undefined when the roster was not read, so no asker is called gone. */
  liveAgents?: ReadonlySet<string>;
  now: number;
  thresholdHours: number;
}

const clip = (text: string): string => (text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text);
const prOf = (row: WatchRow): string => `${row.repo}#${row.pr}`;
const inboxLink = (id: string): string => `#/inbox/${encodeURIComponent(id)}`;
const baseStep = (stepId: string): string => stepId.replace(/:\d+$/, "");

type Unaged = Omit<BannerBlocker, "ageHours">;

function depositBlockers(items: readonly SpoolBlocker[], liveAgents: ReadonlySet<string> | undefined, now: number): Unaged[] {
  return items
    .filter((item) => item.expiresAt === undefined || Date.parse(item.expiresAt) > now)
    .map((item) => ({
      id: item.id,
      source: "blocker" as const,
      summary: clip(item.summary),
      blocks: item.blocker.blocks,
      asker: item.asker,
      ...(liveAgents !== undefined && !liveAgents.has(item.asker) && { askerGone: true as const }),
      since: item.blocker.since,
      link: inboxLink(item.id),
    }));
}

function ownerGate(row: WatchRow): Unaged | undefined {
  const gate = row.pendingGate;
  if (!pinnedLive(row) || gate === null || SEAT_STEPS.has(baseStep(gate.stepId))) return undefined;
  const id = `gate:${gate.gateId}`;
  return { id, source: "owner-gate", summary: clip(`${prOf(row)} waits on ${baseStep(gate.stepId)}`), blocks: prOf(row), asker: "shepherd", since: gate.since, link: inboxLink(id) };
}

/**
 * A hold with a gate pending waits on the gate, which is listed on its own. `satisfiedAt` is the head a reviewer
 * approved, not a time: as Shepherd's `waitsOnHold` reads it, the hold is satisfied only at the run's own head.
 */
function ownerHold(row: WatchRow): Unaged | undefined {
  const { held } = row;
  if (!pinnedLive(row) || held === null || held.satisfiedAt === row.headSha || row.pendingGate !== null) return undefined;
  const link = `#/shepherd/${encodeURIComponent(prOf(row))}`;
  return { id: `held:${row.runId}`, source: "owner-hold", summary: clip(`${prOf(row)} is held: ${held.reason}`), blocks: prOf(row), asker: "shepherd", since: row.phaseSince, link };
}

const oldestFirst = (a: BannerBlocker, b: BannerBlocker): number => Date.parse(a.since) - Date.parse(b.since) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Everything blocked strictly longer than the threshold, oldest first; `count` is the full total, `items` the oldest five. */
export function bannerBlockers({ spoolItems, rows, liveAgents, now, thresholdHours }: BannerInput): Omit<BannerResult, "gaps"> {
  const candidates = [...depositBlockers(spoolItems, liveAgents, now), ...rows.flatMap((row) => [ownerGate(row), ownerHold(row)].filter((each) => each !== undefined))];
  const over = candidates
    .map((item) => ({ ...item, ageMs: now - Date.parse(item.since) }))
    .filter(({ ageMs }) => ageMs > thresholdHours * HOUR)
    .map(({ ageMs, ...item }) => ({ ...item, ageHours: Math.round((ageMs / HOUR) * 10) / 10 }))
    .sort(oldestFirst);
  return { thresholdHours, count: over.length, items: over.slice(0, MAX_ITEMS) };
}

/** Undefined for a deposit with no `blocker`, which the cheap text test skips before any JSON parse. */
async function spoolBlocker(dir: string, name: string): Promise<SpoolBlocker | undefined> {
  const text = await readFile(path.join(dir, name), "utf8");
  if (Buffer.byteLength(text) > MAX_DEPOSIT_BYTES || !text.includes('"blocker"')) return undefined;
  const deposit = ownerItemDepositSchema.parse(JSON.parse(text));
  if (deposit.blocker === undefined || !depositFileNames(deposit.asker, deposit.depositId).includes(name)) return undefined;
  const { asker, summary, blocker, expiresAt } = deposit;
  return { id: depositItemId(asker, deposit.depositId), asker, summary, blocker, ...(expiresAt !== undefined && { expiresAt }) };
}

/** A file that will not read or parse is a gap naming the file, never its contents, and never hides the rest. */
async function readSpoolBlockers(dir: string): Promise<{ items: SpoolBlocker[]; gaps: string[] }> {
  const names = openDepositNames(await spoolNames(dir));
  const read = await Promise.all(names.map((name) => spoolBlocker(dir, name).catch(() => name)));
  return {
    items: read.filter((each): each is SpoolBlocker => typeof each === "object"),
    gaps: read.filter((each): each is string => typeof each === "string").map((name) => `spool: ${name} could not be read as a deposit`),
  };
}

interface BlockerSources {
  spoolDir: string;
  shepherd: Pick<ShepherdSource, "list">;
  thresholdHours?: number;
  now?: () => number;
}

/** A filesystem error names the spool's path, which a LAN caller has no business learning. */
const SPOOL_UNREADABLE = "spool: the inbox spool could not be read";
const failed = (label: string, error: unknown): string => `${label}: ${error instanceof Error ? error.message : String(error)}`;

/** One cached Shepherd read; a factory relay frame drops it, so a moved gate or hold shows on the next read. */
export function blockersCommands({ spoolDir, shepherd, thresholdHours = DEFAULT_BLOCKER_HOURS, now = Date.now }: BlockerSources, invalidation?: Invalidation) {
  const active = cachedRead(() => shepherd.list("active"), BANNER_CACHE_TIMES, now);
  invalidation?.on("factory", active.invalidate);
  return {
    "blockers.banner": readCommand({
      name: "blockers.banner",
      description: "What has waited on the owner longer than the configured hours: blocker deposits, owner gates and unsatisfied holds on live pinned runs, oldest first",
      args: z.object({}),
      result: bannerResult,
      run: async () => {
        const [spool, rows] = await Promise.all([
          readSpoolBlockers(spoolDir).catch(() => ({ items: [], gaps: [SPOOL_UNREADABLE] })),
          active.read().then((value) => ({ value, gaps: [] as string[] }), (error: unknown) => ({ value: [], gaps: [failed("shepherd", error)] })),
        ]);
        const banner = bannerBlockers({ spoolItems: spool.items, rows: rows.value, now: now(), thresholdHours });
        return { ...banner, gaps: [...spool.gaps, ...rows.gaps] };
      },
    }),
  };
}
