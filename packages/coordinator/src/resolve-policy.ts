import type { CharterDefaults, CharterPolicy } from "./charter-policy.js";
import type { SeatConfig } from "./seat-config.js";

export interface ResolvedSeatPolicy {
  hard_stops: string[];
  defaults: CharterDefaults;
}

/**
 * One seat's effective policy. A seat may override any charter default, and its top-level
 * `kind_weights` and `share_caps` merge over the charter's key by key. Hard stops only add:
 * the charter's list is kept whole and the seat's `extra_hard_stops` are appended.
 */
export function resolveSeatPolicy(charter: CharterPolicy, seat: SeatConfig): ResolvedSeatPolicy {
  return { hard_stops: unionHardStops(charter, seat), defaults: mergeSeatDefaults(charter, seat) };
}

// Any `hard_stops` key on the seat itself is ignored: a seat can never remove a global stop.
function unionHardStops(charter: CharterPolicy, seat: SeatConfig): string[] {
  return [...new Set<string>([...charter.hard_stops, ...(seat.extra_hard_stops ?? [])])];
}

function mergeSeatDefaults(charter: CharterPolicy, seat: SeatConfig): CharterDefaults {
  const base = charter.defaults;
  const own = seat.defaults ?? {};
  return {
    ...base,
    ...own,
    kind_weights: { ...base.kind_weights, ...own.kind_weights, ...seat.kind_weights },
    share_caps: { ...base.share_caps, ...own.share_caps, ...seat.share_caps },
    // The stop-short factor is how a hard stop bites in the scorer, so a seat may only
    // lower it; raising it toward 1 would remove the stop in all but name.
    stop_short_factor: Math.min(base.stop_short_factor, own.stop_short_factor ?? Infinity),
  };
}
