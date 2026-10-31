// Measures each changed snapshot from the merge base to the head (TP-4320 S3c). Every cost is bounded by a constant that
// config sets under a zod ceiling, checked before the work: `maxSnapshots` pairs, `maxBytes` per blob against the size
// GitHub reports before the download, `maxPixels` per decode, and `maxTotalPixels` decoded over the step. Each decode's
// pixel limit is the budget still left, so the PR's bytes can make a pair unmeasured but never make the step do more.
import { setImmediate as nextTurn } from "node:timers/promises";
import { BlobTooLargeError, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { statusOf } from "../required-checks.js";
import { decodePngBounded, overPixels, snapshotShare, type Decoded } from "@titan-design/png-delta";

const MI = 1024 * 1024;
const DEFAULT_MAX_SNAPSHOTS = 80;
const DEFAULT_MAX_BYTES = 5 * MI;
const DEFAULT_MAX_PIXELS = 16 * MI;
const DEFAULT_MAX_TOTAL_PIXELS = 128 * MI;
export const OVER_BUDGET = "over the step's pixel budget";

interface MeasureCaps {
  pixelTolerance: number;
  maxSnapshots?: number;
  maxBytes?: number;
  maxPixels?: number;
  maxTotalPixels?: number;
}

export interface MeasureTarget {
  repo: RepoSlug;
  head: string;
  baseRef: string;
}

/** A snapshot to measure: `basePath` is where it sat at the merge base, its rename source if it moved. */
export interface Pair {
  path: string;
  basePath: string;
}

export type PairMeasure = { path: string; share: number } | { path: string; reason: string };

interface Measure {
  port: GitHubPort;
  repo: RepoSlug;
  refs: { base: string; head: string };
  pixelTolerance: number;
  maxBytes: number;
  maxPixels: number;
  /** Pixels the step may still decode; every decode is charged, refused ones at their whole limit. */
  budget: number;
}

async function readBlob(m: Measure, side: "base" | "head", path: string): Promise<Uint8Array | string> {
  try {
    const bytes = await m.port.fileBytes(m.repo, path, m.refs[side], { maxBytes: m.maxBytes });
    return bytes ?? `${side}: absent`;
  } catch (error) {
    return error instanceof BlobTooLargeError ? `${side}: over ${m.maxBytes} bytes` : `${side}: unreadable, ${statusOf(error)}`;
  }
}

/** A refusal is charged its whole limit, as the decoder may have inflated up to it before refusing. */
function decodeCharged(m: Measure, side: "base" | "head", bytes: Uint8Array): Decoded | string {
  const limit = Math.min(m.maxPixels, m.budget);
  const decoded = decodePngBounded(bytes, { maxPixels: limit });
  if ("refused" in decoded) {
    m.budget -= limit;
    return limit < m.maxPixels && decoded.refused === overPixels(limit) ? OVER_BUDGET : `${side}: ${decoded.refused}`;
  }
  m.budget -= decoded.width * decoded.height;
  return decoded;
}

async function readSide(m: Measure, side: "base" | "head", path: string): Promise<Decoded | string> {
  if (m.budget < 1) return OVER_BUDGET;
  const bytes = await readBlob(m, side, path);
  return typeof bytes === "string" ? bytes : decodeCharged(m, side, bytes);
}

async function measurePair(m: Measure, pair: Pair): Promise<PairMeasure> {
  const base = await readSide(m, "base", pair.basePath);
  if (typeof base === "string") return { path: pair.path, reason: base };
  const head = await readSide(m, "head", pair.path);
  if (typeof head === "string") return { path: pair.path, reason: head };
  return { path: pair.path, share: snapshotShare(base, head, { pixelTolerance: m.pixelTolerance }) };
}

async function mergeBaseOf(port: GitHubPort, { repo, baseRef, head }: MeasureTarget): Promise<{ sha: string } | { unread: string }> {
  try {
    return { sha: (await port.compareFiles(repo, baseRef, head)).mergeBaseSha };
  } catch (error) {
    return { unread: `the merge base is unreadable, ${statusOf(error)}` };
  }
}

interface Measured {
  mergeBase: string | null;
  measured: PairMeasure[];
}

/** Over `maxSnapshots`, or with no merge base, every pair is unmeasured and no blob is read. Pairs run one at a time, yielding between them. */
export async function measurePairs(port: GitHubPort, target: MeasureTarget, pairs: readonly Pair[], caps: MeasureCaps): Promise<Measured> {
  if (pairs.length === 0) return { mergeBase: null, measured: [] };
  const cap = caps.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
  const skipAll = (reason: string) => pairs.map((pair) => ({ path: pair.path, reason }));
  if (pairs.length > cap) return { mergeBase: null, measured: skipAll(`${pairs.length} changed snapshots are over the cap of ${cap}`) };
  const base = await mergeBaseOf(port, target);
  if ("unread" in base) return { mergeBase: null, measured: skipAll(base.unread) };
  const limits = { maxBytes: caps.maxBytes ?? DEFAULT_MAX_BYTES, maxPixels: caps.maxPixels ?? DEFAULT_MAX_PIXELS, budget: caps.maxTotalPixels ?? DEFAULT_MAX_TOTAL_PIXELS };
  const m: Measure = { port, repo: target.repo, refs: { base: base.sha, head: target.head }, pixelTolerance: caps.pixelTolerance, ...limits };
  const measured: PairMeasure[] = [];
  for (const pair of pairs) {
    measured.push(await measurePair(m, pair).catch(() => ({ path: pair.path, reason: "the measure threw" })));
    await nextTurn();
  }
  return { mergeBase: base.sha, measured };
}
