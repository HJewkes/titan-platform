import { NOW_MS, fixtureSnapshot } from "./fixture.js";
import type { Snapshot } from "./snapshot.js";

const later = <T extends { atMs: number }>(reading: T | null, by: number): T | null => (reading === null ? null : { ...reading, atMs: reading.atMs + by });

/**
 * The synthetic fixture as if read at `nowMs`, for `titan-fleet-feed --demo`: a pane to review
 * and screenshot with no broker and no real agent behind it.
 */
export function demoSnapshot(nowMs: number): Snapshot {
  const by = nowMs - NOW_MS;
  const snapshot = fixtureSnapshot();
  return {
    ...snapshot,
    atMs: nowMs,
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      report: later(agent.report, by),
      cost: later(agent.cost, by),
      context: agent.context?.source === "status-line" ? { ...agent.context, atMs: agent.context.atMs + by } : agent.context,
    })),
    accounts: snapshot.accounts.map((strip) => ({
      ...strip,
      readAtMs: strip.readAtMs === null ? null : strip.readAtMs + by,
      fiveHour: strip.fiveHour && { ...strip.fiveHour, resetsAtMs: strip.fiveHour.resetsAtMs === null ? null : strip.fiveHour.resetsAtMs + by },
      sevenDay: strip.sevenDay && { ...strip.sevenDay, resetsAtMs: strip.sevenDay.resetsAtMs === null ? null : strip.sevenDay.resetsAtMs + by },
    })),
  };
}
