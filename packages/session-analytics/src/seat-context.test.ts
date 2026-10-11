import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertCompaction, insertRequest, type FixtureGraph } from "./fixture.js";
import { seatContext } from "./seat-context.js";

const WINDOW = { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" };
const COORD = { name: "coord", sessionIds: ["seat-a"] };

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
});
afterEach(() => fixture.close());

function seedTenCalls(sessionId: string): void {
  for (let i = 1; i <= 10; i += 1) insertRequest(fixture.graph.db, { sessionId, ts: `2026-10-01T0${i - 1}:00:00Z`, cacheReadTokens: i * 100_000 });
}

function coordRow() {
  return seatContext(fixture.openReadOnly(), { window: WINDOW, sessions: [COORD] })[0]!;
}

describe("seat context", () => {
  it("takes p90 as the value at floor(n * 0.9) of the sorted calls", () => {
    seedTenCalls("seat-a");

    const row = coordRow();

    expect(row).toMatchObject({ name: "coord", requests: 10, p50: 600_000, p90: 1_000_000, max: 1_000_000 });
  });

  it("counts input, cache read and cache write toward a call's context", () => {
    insertRequest(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-01T01:00:00Z", inputTokens: 10, cacheReadTokens: 200_000, cacheCreation1h: 50_000 });

    expect(coordRow().max).toBe(250_010);
  });

  it("leaves sidechain and synthetic calls out", () => {
    seedTenCalls("seat-a");
    insertRequest(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-01T11:00:00Z", cacheReadTokens: 900_000, isSidechain: true });
    for (let i = 0; i < 3; i += 1) insertRequest(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-01T12:00:00Z", model: "<synthetic>" });

    const row = coordRow();

    expect(row).toMatchObject({ requests: 10, p50: 600_000 });
  });

  it("counts a request copied into a second transcript once, and only calls inside the window", () => {
    seedTenCalls("seat-a");
    insertRequest(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-01T00:00:00Z", requestId: "copied", transcriptId: 1 });
    insertRequest(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-01T00:00:01Z", requestId: "copied", transcriptId: 2 });
    insertRequest(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-02T00:00:00Z", cacheReadTokens: 5_000_000 });

    expect(coordRow()).toMatchObject({ requests: 11, max: 1_000_000 });
  });

  it("scopes each seat to its own sessions, compactions included", () => {
    seedTenCalls("seat-a");
    insertRequest(fixture.graph.db, { sessionId: "other", ts: "2026-10-01T01:00:00Z", cacheReadTokens: 2_000_000 });
    insertCompaction(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-01T03:00:00Z", trigger: "auto" });
    insertCompaction(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-01T05:00:00Z", trigger: "auto" });
    insertCompaction(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-01T06:00:00Z", trigger: "manual" });
    insertCompaction(fixture.graph.db, { sessionId: "other", ts: "2026-10-01T04:00:00Z", trigger: "auto" });
    insertCompaction(fixture.graph.db, { sessionId: "seat-a", ts: "2026-10-03T00:00:00Z", trigger: "auto" });

    const [coord, other] = seatContext(fixture.openReadOnly(), { window: WINDOW, sessions: [COORD, { name: "other", sessionIds: ["other"] }] });

    expect(coord).toMatchObject({ max: 1_000_000, compactions: { auto: 2, manual: 1 } });
    expect(other).toMatchObject({ requests: 1, compactions: { auto: 1, manual: 0 } });
  });

  it("reports zeros for a seat with no calls in the window", () => {
    expect(coordRow()).toEqual({ name: "coord", requests: 0, p50: 0, p90: 0, max: 0, compactions: { auto: 0, manual: 0 } });
  });
});
