import { createHash } from "node:crypto";
import type { GateRecord } from "@titan-design/hitl";
import { isOwnerTouch } from "../shepherd/owner-friction.js";
import { isoWeek } from "../shepherd/stats.js";

const DAY_MS = 86_400_000;
const WEEK = /^(\d{4})-W(\d{2})$/;

/**
 * The one owner-resolved predicate the audit and the weekly report share: an owner-class resolve made under no grant.
 * A delegate's resolve under a grant was not the owner's decision, so auditing it would audit the wrong person.
 */
export const isOwnerResolved = (gate: GateRecord): boolean => isOwnerTouch(gate) && gate.resolvedAt !== undefined;

/** `[start, end)` in epoch ms of an ISO week such as `2026-W41`; week 1 holds the year's first Thursday, so it holds 4 January. */
export function weekBounds(week: string): { start: number; end: number } {
  const match = WEEK.exec(week);
  const number = match ? Number(match[2]) : 0;
  if (!match || number < 1 || number > 53) throw new Error(`not an ISO week: ${week} (want YYYY-Www)`);
  const jan4 = Date.UTC(Number(match[1]), 0, 4);
  const start = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * DAY_MS + (number - 1) * 7 * DAY_MS;
  if (isoWeek(start) !== week) throw new Error(`not an ISO week: ${week} (that year has no week ${match[2]})`);
  return { start, end: start + 7 * DAY_MS };
}

/** The first 32 bits of sha256 over the week, so a re-run of the same week draws the same sample. */
export function weekSeed(week: string): number {
  return createHash("sha256").update(week).digest().readUInt32BE(0);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const next = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The owner-resolved gates whose resolve falls in `week`, in id order so the store's read order cannot move the sample. */
export function weekPopulation(gates: readonly GateRecord[], week: string): GateRecord[] {
  const { start, end } = weekBounds(week);
  return gates
    .filter((gate) => isOwnerResolved(gate) && Date.parse(gate.resolvedAt!) >= start && Date.parse(gate.resolvedAt!) < end)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Up to `n` of the week's owner-resolved gates, shuffled by the week's seed: all of them when there are fewer. */
export function sampleOwnerGates(gates: readonly GateRecord[], week: string, n = 5): GateRecord[] {
  return seededShuffle(weekPopulation(gates, week), weekSeed(week)).slice(0, n);
}
