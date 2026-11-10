import type { TtlRequestRow } from "./cache-ttl.js";
import { GAP_BANDS, gapBand } from "./bands.js";
import type { PriceRow } from "./prices.js";

const MTOK = 1e6;
const REVERSE_GAP_BAND = GAP_BANDS[1]!.name;

/**
 * Tokens a 1h TTL would have served as a read instead of a rebuild write, per request. Only sessions
 * observed purely on 5m are replayed: one 1h write marks a mixed or 1h session, where nothing is claimed.
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

function bySession(rows: readonly TtlRequestRow[]): Map<string, TtlRequestRow[]> {
  const sessions = new Map<string, TtlRequestRow[]>();
  for (const row of rows) {
    const members = sessions.get(row.sessionId);
    if (members) members.push(row);
    else sessions.set(row.sessionId, [row]);
  }
  return sessions;
}
