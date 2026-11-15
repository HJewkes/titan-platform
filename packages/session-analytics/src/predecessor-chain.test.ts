import { afterEach, describe, expect, it } from "vitest";
import type { HandoffRecord } from "./events-db.js";
import { createFixtureGraph, insertOrigin, insertSession, type FixtureGraph } from "./fixture.js";
import { parseBrokerLog } from "./liveness-broker.js";
import { predecessorChain, type PredecessorChainInput } from "./predecessor-chain.js";

let fixture: FixtureGraph | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

interface Session {
  id: string;
  name: string;
  agentId: string;
  predecessor?: string;
}

function seed(sessions: readonly Session[]) {
  fixture = createFixtureGraph();
  const db = fixture.graph.db;
  for (const s of sessions) {
    insertSession(db, { sessionId: s.id });
    insertOrigin(db, { sessionId: s.id, depth: 1, agentName: s.name, agentId: s.agentId, predecessor: s.predecessor ?? null });
  }
  const agentSessions = new Map<string, string[]>();
  for (const s of sessions) agentSessions.set(s.agentId, [...(agentSessions.get(s.agentId) ?? []), s.id]);
  return { db, agentSessions };
}

const handoff = (eventId: number, at: string, seat: string, predecessorId: string, successorId: string): HandoffRecord => ({ eventId, at, seat, predecessorId, successorId, committed: true });

function input(agentSessions: Map<string, string[]>, handoffs: HandoffRecord[] = [], broker: Record<string, unknown>[] = []): PredecessorChainInput {
  return { handoffs, broker: parseBrokerLog(broker.map((e) => JSON.stringify(e))), agentSessions };
}

const summary = (links: ReturnType<typeof predecessorChain>) => links.map((l) => [l.agentName, l.agentId, l.sessionIds, l.kind]);

describe("predecessorChain", () => {
  it("lists two generations of one seat oldest first after a committed handoff", () => {
    const { db, agentSessions } = seed([
      { id: "s1", name: "coord", agentId: "g1" },
      { id: "s2", name: "coord", agentId: "g2" },
    ]);

    const chain = predecessorChain(db, "s2", input(agentSessions, [handoff(1, "2026-10-01T02:00:00Z", "coord", "g1", "g2")]));

    expect(summary(chain)).toEqual([
      ["coord", "g1", ["s1"], "generation"],
      ["coord", "g2", ["s2"], "generation"],
    ]);
    expect(chain[0]?.end).toBe("2026-10-01T02:00:00Z");
    expect(chain[1]?.start).toBe("2026-10-01T02:00:00Z");
  });

  it("links a renamed successor to its predecessor only through the origin row", () => {
    const { db, agentSessions } = seed([
      { id: "a", name: "impl-a", agentId: "ia" },
      { id: "b", name: "impl-a-s1", agentId: "ib", predecessor: "impl-a" },
    ]);

    const chain = predecessorChain(db, "b", input(agentSessions));

    expect(summary(chain)).toEqual([
      ["impl-a", "ia", ["a"], "predecessor"],
      ["impl-a-s1", "ib", ["b"], "generation"],
    ]);
  });

  it("follows a three-hop chain that mixes a handoff and a rename", () => {
    const { db, agentSessions } = seed([
      { id: "a1", name: "impl-a", agentId: "a1g" },
      { id: "a2", name: "impl-a", agentId: "a2g" },
      { id: "b", name: "impl-a-s1", agentId: "bg", predecessor: "impl-a" },
      { id: "c", name: "impl-a-s2", agentId: "cg", predecessor: "impl-a-s1" },
    ]);

    const chain = predecessorChain(db, "c", input(agentSessions, [handoff(1, "2026-10-01T01:00:00Z", "impl-a", "a1g", "a2g")]));

    expect(summary(chain)).toEqual([
      ["impl-a", "a1g", ["a1"], "generation"],
      ["impl-a", "a2g", ["a2"], "predecessor"],
      ["impl-a-s1", "bg", ["b"], "predecessor"],
      ["impl-a-s2", "cg", ["c"], "generation"],
    ]);
  });

  it("stops when a predecessor points back into the chain", () => {
    const { db, agentSessions } = seed([
      { id: "x", name: "alpha", agentId: "xg", predecessor: "beta" },
      { id: "y", name: "beta", agentId: "yg", predecessor: "alpha" },
    ]);

    const chain = predecessorChain(db, "x", input(agentSessions));

    expect(summary(chain)).toEqual([
      ["beta", "yg", ["y"], "predecessor"],
      ["alpha", "xg", ["x"], "generation"],
    ]);
  });

  it("returns only the session when it has no origin row", () => {
    const { db, agentSessions } = seed([]);

    const chain = predecessorChain(db, "lone", input(agentSessions));

    expect(chain).toEqual([{ agentName: null, agentId: null, sessionIds: ["lone"], start: null, end: null, kind: "generation" }]);
  });
});
