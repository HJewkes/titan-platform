import type { TtlRequestRow } from "./cache-ttl.js";
import { GAP_BANDS, gapBand } from "./bands.js";
import type { PriceRow } from "./prices.js";

const MTOK = 1e6;
const REVERSE_GAP_BAND = GAP_BANDS[1]!.name;

/**
 * Tokens a 1h TTL would have served as a read instead of a rebuild write, per request. Only chains
 * (a session's main chain, or one of its sidechains) observed purely on 5m are replayed: one 1h write
 * marks a mixed or 1h chain, where nothing is claimed. A main chain on 5m is therefore replayed even
 * when its sidechain wrote at 1h, and the reverse.
 * After a 5-60 minute gap the 1h cache still held the previous prompt, so `min(write, previous prompt)`
 * reverts. A first request, a gap past an hour (1h expired too) and a missing previous request claim nothing.
 */
export function reverseReplayTokens(rows: readonly TtlRequestRow[]): Map<TtlRequestRow, number> {
  const reverted = new Map<TtlRequestRow, number>();
  for (const session of bySession(rows).values()) {
    if (!isFiveMinuteSession(session)) continue;
    const ordered = [...session].sort((a, b) => a.ts.localeCompare(b.ts));
    ordered.forEach((row, index) => {
      if (index === 0 || row.gapMs === null || gapBand(row.gapMs) !== REVERSE_GAP_BAND) return;
      const tokens = Math.min(row.cacheWrite5mTokens, promptTokens(ordered[index - 1]!));
      if (tokens > 0) reverted.set(row, tokens);
    });
  }
  return reverted;
}

/** 5m write tokens of every request in a replayed session; a 1h TTL would write them at the 1h rate unless they revert to reads. */
export function reverseWriteTokens(rows: readonly TtlRequestRow[]): Map<TtlRequestRow, number> {
  const written = new Map<TtlRequestRow, number>();
  for (const session of bySession(rows).values()) {
    if (!isFiveMinuteSession(session)) continue;
    for (const row of session) written.set(row, row.cacheWrite5mTokens);
  }
  return written;
}

/** The 1h write rate over the 5m rate, charged on the writes a replay keeps. */
export function reversePremiumUsd(tokens: number, price: PriceRow): number {
  return (tokens * (price.cacheWrite1h - price.cacheWrite5m)) / MTOK;
}

/** The rebuild write becomes a read, so the request saves the write rate less the read rate. */
export function reverseSavingUsd(tokens: number, price: PriceRow): number {
  return (tokens * (price.cacheWrite5m - price.cacheRead)) / MTOK;
}

function promptTokens(row: TtlRequestRow): number {
  return row.cacheReadTokens + row.cacheWrite5mTokens + row.cacheWrite1hTokens;
}

function isFiveMinuteSession(rows: readonly TtlRequestRow[]): boolean {
  return rows.some((row) => row.cacheWrite5mTokens > 0) && rows.every((row) => row.cacheWrite1hTokens === 0);
}

/** Rows grouped by (session, chain): a sidechain has its own cache, so it is never a main request's previous prompt. */
function bySession(rows: readonly TtlRequestRow[]): Map<string, TtlRequestRow[]> {
  const sessions = new Map<string, TtlRequestRow[]>();
  for (const row of rows) {
    const key = `${row.sessionId}\u0000${row.isSidechain}`;
    const members = sessions.get(key);
    if (members) members.push(row);
    else sessions.set(key, [row]);
  }
  return sessions;
}
