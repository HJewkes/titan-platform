import type { Db } from "@titan-design/store-sqlite";
import type { HealthSample, SampleStatus } from "./sample.js";
import { readSamples } from "./store.js";

export const DEFAULT_TICK_SECONDS = 60;

export interface UptimeWindow {
  from: Date;
  to: Date;
  /** Slot width; slots are aligned to the epoch so they match a wall-clock minutely timer. */
  tickSeconds?: number;
}

export interface UptimeGap {
  from: string;
  to: string;
}

export interface UptimeReport {
  slots: number;
  /** pass or warn: the target answered. */
  up: number;
  down: number;
  /** The probe could not decide; neither up nor down. */
  unknown: number;
  /** No sample at all; never counted as up. */
  missing: number;
  /** `up / slots`, or null for a window with no whole slot. */
  upShareOfWindow: number | null;
  /** `up / (up + down)`, or null when nothing was observed up or down. */
  upShareOfObserved: number | null;
  /** Runs of consecutive missing slots, oldest first. */
  gaps: UptimeGap[];
}

// Several samples in one slot fold to the worst, so a fail is never hidden by a later pass.
const SEVERITY: Record<SampleStatus, number> = { pass: 0, warn: 1, unknown: 2, fail: 3 };

interface SlotRange {
  first: number;
  end: number;
  tickMs: number;
}

/** Whole slots only: a partial edge slot could read as missing just because its tick fell outside the window. */
function slotRange(window: UptimeWindow): SlotRange {
  const tickSeconds = window.tickSeconds ?? DEFAULT_TICK_SECONDS;
  // A zero tick makes every slot Infinity and the slot loop never ends.
  if (!Number.isFinite(tickSeconds) || tickSeconds <= 0) {
    throw new RangeError(`tickSeconds must be a positive finite number, got ${tickSeconds}`);
  }
  const tickMs = tickSeconds * 1000;
  const first = Math.ceil(window.from.getTime() / tickMs);
  const end = Math.max(first, Math.floor(window.to.getTime() / tickMs));
  return { first, end, tickMs };
}

function worstBySlot(samples: readonly HealthSample[], range: SlotRange): Map<number, SampleStatus> {
  const worst = new Map<number, SampleStatus>();
  for (const sample of samples) {
    const slot = Math.floor(Date.parse(sample.ts) / range.tickMs);
    if (slot < range.first || slot >= range.end) continue;
    const seen = worst.get(slot);
    if (seen === undefined || SEVERITY[sample.status] > SEVERITY[seen]) worst.set(slot, sample.status);
  }
  return worst;
}

function share(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

type SlotCounts = Pick<UptimeReport, "up" | "down" | "unknown" | "missing" | "gaps">;

function countSlots(worst: Map<number, SampleStatus>, range: SlotRange): SlotCounts {
  const counts: SlotCounts = { up: 0, down: 0, unknown: 0, missing: 0, gaps: [] };
  const iso = (slot: number) => new Date(slot * range.tickMs).toISOString();
  let gapStart: number | null = null;
  for (let slot = range.first; slot <= range.end; slot++) {
    const status = slot < range.end ? worst.get(slot) : "end";
    if (status === undefined) {
      counts.missing += 1;
      gapStart ??= slot;
      continue;
    }
    if (gapStart !== null) counts.gaps.push({ from: iso(gapStart), to: iso(slot) });
    gapStart = null;
    if (status === "fail") counts.down += 1;
    else if (status === "unknown") counts.unknown += 1;
    else if (status !== "end") counts.up += 1;
  }
  return counts;
}

/** Pure fold of one target's samples over `[from, to)`; up, down, unknown and missing are kept apart. */
export function foldUptime(samples: readonly HealthSample[], window: UptimeWindow): UptimeReport {
  const range = slotRange(window);
  const { gaps, ...counts } = countSlots(worstBySlot(samples, range), range);
  const slots = range.end - range.first;
  return {
    slots,
    ...counts,
    upShareOfWindow: share(counts.up, slots),
    upShareOfObserved: share(counts.up, counts.up + counts.down),
    gaps,
  };
}

/** Uptime of `target` over `[from, to)`, read from the store and folded by `foldUptime`. */
export function uptime(db: Db, target: string, from: Date, to: Date, options: { tickSeconds?: number } = {}): UptimeReport {
  const window = { from, to, tickSeconds: options.tickSeconds };
  const range = slotRange(window);
  const samples = readSamples(db, target, new Date(range.first * range.tickMs), new Date(range.end * range.tickMs));
  return foldUptime(samples, window);
}
