import type { CacheBreakpoint, FirstRequest, RequestBlock } from "@titan-design/session-read";
import { priceRequest } from "./price-request.js";

/** A first request plus the account whose cache it hit; caches are per account. */
export interface PrefixRow extends FirstRequest {
  account: string;
}

export interface PrefixReuseOptions {
  /** A cached prefix counts as read when the same key was last seen strictly less than this many minutes earlier. */
  windowMin?: number;
  /** How many same-corpus pairs to compare for first divergence. */
  pairs?: number;
}

export interface Divergence {
  /** Path of the block holding the first differing byte, e.g. `system[2]`. */
  path: string;
  /** UTF-8 bytes from the start of the first block to the first differing byte, blocks concatenated with no separator. */
  absoluteByte: number;
  /** UTF-16 units into that block. */
  inBlockChar: number;
}

export interface DivergenceGroup {
  path: string;
  pairs: number;
  medianAbsoluteByte: number;
}

export interface PrefixReuse {
  sessions: number;
  /** Sessions whose first response reported usage; the share and dollar fields cover only these. */
  measured: number;
  /** Sum of cache reads over sum of input tokens (fresh + written + read). */
  tokenShare: number;
  medianShare: number;
  medianFirstCallTokens: number;
  atLeast60: number;
  atLeast70: number;
  /** Input-side spend of the first calls at list price: fresh, cache read and cache write; output excluded. */
  inputUsd: number;
  hit: { hits: number; total: number; rate: number };
  divergence: { pairs: number; identical: number; byBlock: DivergenceGroup[] };
  cacheControl: { signature: string; sessions: number }[];
}

const DEFAULT_WINDOW_MIN = 60;
const DEFAULT_PAIRS = 200;
const MS_PER_MIN = 60_000;
const SYSTEM_PREFIX_PATH = "system[2]";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function firstDifferingChar(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  return limit;
}

function sameBlock(a: RequestBlock | undefined, b: RequestBlock | undefined): boolean {
  return a !== undefined && b !== undefined && a.path === b.path && a.text === b.text;
}

/** Where two requests first differ, in block order; null when every block matches. */
export function firstDivergence(a: readonly RequestBlock[], b: readonly RequestBlock[]): Divergence | null {
  let bytes = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    if (sameBlock(left, right)) {
      bytes += Buffer.byteLength(left!.text);
      continue;
    }
    const owner = left ?? right!;
    const at = left && right && left.path === right.path ? firstDifferingChar(left.text, right.text) : 0;
    return { path: owner.path, absoluteByte: bytes + Buffer.byteLength(owner.text.slice(0, at)), inBlockChar: at };
  }
  return null;
}

function prefixKey(row: PrefixRow): string {
  const prefix = row.blocks.find((block) => block.path === SYSTEM_PREFIX_PATH)?.text ?? "";
  return JSON.stringify([row.account, row.model, prefix]);
}

function simulateHits(rows: readonly PrefixRow[], windowMin: number): PrefixReuse["hit"] {
  const dated = rows.flatMap((row) => {
    const at = row.timestamp ? Date.parse(row.timestamp) : Number.NaN;
    return Number.isNaN(at) ? [] : [{ key: prefixKey(row), at }];
  });
  dated.sort((a, b) => a.at - b.at);
  const lastSeen = new Map<string, number>();
  let hits = 0;
  for (const { key, at } of dated) {
    const previous = lastSeen.get(key);
    if (previous !== undefined && at - previous < windowMin * MS_PER_MIN) hits++;
    lastSeen.set(key, at);
  }
  return { hits, total: dated.length, rate: dated.length ? hits / dated.length : 0 };
}

/** Deterministic spread of distinct index pairs over the corpus, so a rerun compares the same pairs. */
function samplePairs(count: number, wanted: number): [number, number][] {
  const out: [number, number][] = [];
  const capacity = count * (count - 1);
  for (let n = 0; n < Math.min(wanted, capacity); n++) {
    const i = n % count;
    out.push([i, (i + 1 + Math.floor(n / count)) % count]);
  }
  return out;
}

function compareSample(rows: readonly PrefixRow[], wanted: number): PrefixReuse["divergence"] {
  const byPath = new Map<string, number[]>();
  let identical = 0;
  const pairs = samplePairs(rows.length, wanted);
  for (const [i, j] of pairs) {
    const found = firstDivergence(rows[i]!.blocks, rows[j]!.blocks);
    if (!found) identical++;
    else byPath.set(found.path, [...(byPath.get(found.path) ?? []), found.absoluteByte]);
  }
  const byBlock = [...byPath].map(([path, bytes]) => ({ path, pairs: bytes.length, medianAbsoluteByte: median(bytes) }));
  byBlock.sort((a, b) => b.pairs - a.pairs || (a.path < b.path ? -1 : 1));
  return { pairs: pairs.length, identical, byBlock };
}

function signature(breakpoints: readonly CacheBreakpoint[]): string {
  return breakpoints.map((b) => `${b.path}:${b.ttl ?? "-"}:${b.scope ?? "-"}`).join(" ");
}

function countSignatures(rows: readonly PrefixRow[]): PrefixReuse["cacheControl"] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(signature(row.cacheControl), (counts.get(signature(row.cacheControl)) ?? 0) + 1);
  return [...counts].map(([sig, sessions]) => ({ signature: sig, sessions })).sort((a, b) => b.sessions - a.sessions);
}

interface Measured {
  total: number;
  read: number;
  usd: number;
}

function measure(rows: readonly PrefixRow[]): Measured[] {
  return rows.flatMap((row) => {
    const usage = row.usage;
    if (!usage) return [];
    const total = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
    const priced = priceRequest({ ...usage, outputTokens: 0 }, row.model ?? "", row.timestamp ?? "");
    return total > 0 ? [{ total, read: usage.cacheReadTokens, usd: priced.costUsd }] : [];
  });
}

/**
 * First-call cache reuse over a set of first requests: how much of each call was read from cache, what the
 * input side cost, whether the `system[2]` prefix would have been warm within the window, and where pairs
 * of requests first stop matching.
 */
export function prefixReuse(rows: readonly PrefixRow[], options: PrefixReuseOptions = {}): PrefixReuse {
  const measured = measure(rows);
  const total = measured.reduce((sum, m) => sum + m.total, 0);
  const shares = measured.map((m) => m.read / m.total);
  return {
    sessions: rows.length,
    measured: measured.length,
    tokenShare: total ? measured.reduce((sum, m) => sum + m.read, 0) / total : 0,
    medianShare: median(shares),
    medianFirstCallTokens: median(measured.map((m) => m.total)),
    atLeast60: shares.filter((s) => s >= 0.6).length,
    atLeast70: shares.filter((s) => s >= 0.7).length,
    inputUsd: measured.reduce((sum, m) => sum + m.usd, 0),
    hit: simulateHits(rows, options.windowMin ?? DEFAULT_WINDOW_MIN),
    divergence: compareSample(rows, options.pairs ?? DEFAULT_PAIRS),
    cacheControl: countSignatures(rows),
  };
}
