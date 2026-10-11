import { describe, expect, it } from "vitest";
import type { HandoffRecord } from "./events-db.js";
import { parseBrokerLog } from "./liveness-broker.js";
import { seatGenerations, seatGenerationsSchema, type SeatGenerationsInput } from "./seat-generations.js";

const SEAT = "coord-a";

function handoff(eventId: number, at: string, predecessorId: string, successorId: string, overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return { eventId, at, seat: SEAT, predecessorId, successorId, committed: true, ...overrides };
}

function broker(...entries: Record<string, unknown>[]) {
  return parseBrokerLog(entries.map((entry) => JSON.stringify(entry)));
}

const spawned = (ts: string, agentId: string, name = SEAT) => ({ ts, event: "agent_spawned", agentId, name });
const exited = (ts: string, agentId: string, name = SEAT) => ({ ts, event: "agent_exited", agentId, name, code: 0 });
const teleported = (ts: string, from: string, to: string, name = SEAT) => ({ ts, event: "teleport_completed", name, from, to });

function resolve(overrides: Partial<SeatGenerationsInput>) {
  return seatGenerations({ handoffs: [], broker: [], agentSessions: new Map(), seat: SEAT, ...overrides });
}

describe("seat generations", () => {
  it("orders handoffs and a teleport by time across sources, each ended by what closed it", () => {
    const generations = resolve({
      // The teleport row is listed first, but its generation came last.
      broker: broker(teleported("2026-10-01T12:00:00Z", "g3", "g4"), spawned("2026-10-01T00:00:00Z", "g1")),
      handoffs: [handoff(9, "2026-10-01T04:00:00Z", "g2", "g3"), handoff(2, "2026-10-01T02:00:00Z", "g1", "g2")],
    });

    expect(generations.map((g) => [g.generation, g.agentId, g.start, g.end, g.endedBy])).toEqual([
      [1, "g1", "2026-10-01T00:00:00Z", "2026-10-01T02:00:00Z", "handoff"],
      [2, "g2", "2026-10-01T02:00:00Z", "2026-10-01T04:00:00Z", "handoff"],
      [3, "g3", "2026-10-01T04:00:00Z", "2026-10-01T12:00:00Z", "teleport"],
      [4, "g4", "2026-10-01T12:00:00Z", null, "open"],
    ]);
    expect(seatGenerationsSchema.parse(generations)).toEqual(generations);
  });

  it("drops generations ended before since and keeps the one running at since", () => {
    const generations = resolve({
      handoffs: [handoff(1, "2026-10-01T02:00:00Z", "g1", "g2"), handoff(2, "2026-10-01T08:00:00Z", "g2", "g3")],
      since: "2026-10-01T05:00:00Z",
    });

    expect(generations.map((g) => [g.generation, g.agentId, g.endedBy])).toEqual([
      [1, "g2", "handoff"],
      [2, "g3", "open"],
    ]);
  });

  it("keeps a generation with no graph session, with no session ids", () => {
    const generations = resolve({
      handoffs: [handoff(1, "2026-10-01T02:00:00Z", "g1", "g2")],
      agentSessions: new Map([["g1", ["s-1", "s-1b"]]]),
    });

    expect(generations.map((g) => [g.agentId, g.sessionIds])).toEqual([
      ["g1", ["s-1", "s-1b"]],
      ["g2", []],
    ]);
  });

  it("ignores another seat's handoffs, teleports, spawns and exits", () => {
    const generations = resolve({
      handoffs: [handoff(1, "2026-10-01T02:00:00Z", "o1", "o2", { seat: "coord-b" })],
      broker: broker(spawned("2026-10-01T00:00:00Z", "o1", "coord-b"), teleported("2026-10-01T03:00:00Z", "o2", "o3", "coord-b"), exited("2026-10-01T04:00:00Z", "o3", "coord-b")),
    });

    expect(generations).toEqual([]);
  });

  it("counts a handover logged both as a handoff row and a teleport line once, as a handoff", () => {
    const generations = resolve({
      handoffs: [handoff(1, "2026-10-01T02:00:00Z", "g1", "g2")],
      broker: broker(teleported("2026-10-01T02:00:05Z", "g1", "g2"), exited("2026-10-01T02:00:10Z", "g1")),
    });

    expect(generations.map((g) => [g.agentId, g.endedBy])).toEqual([
      ["g1", "handoff"],
      ["g2", "open"],
    ]);
  });

  it("does not end a generation on an aborted handoff, and ends it on exit", () => {
    const generations = resolve({
      handoffs: [handoff(1, "2026-10-01T02:00:00Z", "g1", "g2", { committed: false })],
      broker: broker(spawned("2026-10-01T00:00:00Z", "g1"), exited("2026-10-01T06:00:00Z", "g1"), spawned("2026-10-01T07:00:00Z", "g5")),
    });

    expect(generations.map((g) => [g.agentId, g.end, g.endedBy])).toEqual([
      ["g1", "2026-10-01T06:00:00Z", "exit"],
      ["g5", null, "open"],
    ]);
  });
});
