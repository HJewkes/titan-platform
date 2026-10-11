import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCostRows } from "./cost-report-queries.js";
import { createFixtureGraph, insertActionCall, insertOrigin, insertPrices, insertRequest, insertSession, type FixtureGraph } from "./fixture.js";
import { successorReworkReport, successorReworkSchema } from "./successor-rework.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  insertPrices(fixture.graph);
});
afterEach(() => fixture.close());

const WINDOW = { since: "2026-09-20", until: "2026-09-21" };
const at = (hour: number, minute: number) => `2026-09-20T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;

interface Turn {
  minute: number;
  reads?: string[];
  writes?: string[];
  inputTokens?: number;
}

/** A named implementer session on its own transcript: one request per turn in `hour`, each issuing its reads and writes. */
function session(sessionId: string, agentName: string, transcriptId: number, hour: number, turns: Turn[]): void {
  const db = fixture.graph.db;
  insertSession(db, { sessionId });
  insertOrigin(db, { sessionId, depth: 1, profile: "implementer", agentName, originKind: "spawned" });
  for (const turn of turns) {
    const ts = at(hour, turn.minute);
    insertRequest(db, { sessionId, transcriptId, ts, requestId: `${sessionId}-${turn.minute}`, inputTokens: turn.inputTokens ?? 0 });
    for (const detail of turn.reads ?? []) insertActionCall(db, { sessionId, transcriptId, ts, name: "Read", signal: "file_read", detail });
    for (const detail of turn.writes ?? []) insertActionCall(db, { sessionId, transcriptId, ts, name: "Write", signal: "file_write", detail });
  }
}

/** `count` turns from minute 0, the one at 1-based `readAt` reading `path`. */
function turnsReadingAt(count: number, readAt: number, path: string): Turn[] {
  return Array.from({ length: count }, (_, i) => (i + 1 === readAt ? { minute: i, reads: [path] } : { minute: i }));
}

const report = (bootRequests?: number) => {
  const result = successorReworkReport(fixture.openReadOnly(), WINDOW, bootRequests === undefined ? {} : { bootRequests });
  expect(successorReworkSchema.parse(result)).toEqual(result);
  return result;
};

describe("successorReworkReport", () => {
  it("counts a file the predecessor read that the successor reads within its boot requests", () => {
    session("p-1", "impl-a", 1, 9, [{ minute: 0, reads: ["src/a.ts"] }]);
    session("s-1", "impl-a", 2, 10, turnsReadingAt(5, 5, "src/a.ts"));

    const result = report();

    expect(result.fileReadData).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ pairs: 1, meanBootReads: 1, meanRereads: 1, rereadShare: 1 });
  });

  it("does not count a re-read after the boot requests", () => {
    session("p-1", "impl-a", 1, 9, [{ minute: 0, reads: ["src/a.ts"] }]);
    session("s-1", "impl-a", 2, 10, turnsReadingAt(40, 40, "src/a.ts"));

    const result = report(30);

    expect(result.rows[0]).toMatchObject({ pairs: 1, meanBootReads: 0, meanRereads: 0, rereadShare: null, rereadCostUsd: 0 });
  });

  it("does not pair two same-name sessions that overlap in time", () => {
    session("o-1", "impl-b", 1, 10, [{ minute: 0, reads: ["src/a.ts"] }, { minute: 30 }]);
    session("o-2", "impl-b", 2, 10, [{ minute: 10, reads: ["src/a.ts"] }, { minute: 40 }]);

    expect(report().rows).toEqual([]);
  });

  it("does not count a file the predecessor only wrote", () => {
    session("p-1", "impl-a", 1, 9, [{ minute: 0, writes: ["src/w.ts"] }]);
    session("s-1", "impl-a", 2, 10, [{ minute: 0, reads: ["src/w.ts"] }]);

    expect(report().rows[0]).toMatchObject({ pairs: 1, meanBootReads: 1, meanRereads: 0, rereadShare: 0, rereadCostUsd: 0 });
  });

  it("costs a boot request that re-reads two files once", () => {
    session("p-1", "impl-a", 1, 9, [{ minute: 0, reads: ["src/a.ts", "src/b.ts"] }]);
    session("s-1", "impl-a", 2, 10, [{ minute: 0, reads: ["src/a.ts", "src/b.ts"], inputTokens: 1_000_000 }, { minute: 1, inputTokens: 1_000_000 }]);
    const requestCost = readCostRows(fixture.openReadOnly(), WINDOW).find((row) => row.requestId === "s-1-0")!.costUsd;

    const row = report().rows[0];

    expect(requestCost).toBeGreaterThan(0);
    expect(row).toMatchObject({ meanRereads: 2 });
    expect(row?.rereadCostUsd).toBeCloseTo(requestCost);
  });

  it("reports no file_read data when the graph has no file_read signal", () => {
    session("p-1", "impl-a", 1, 9, [{ minute: 0, writes: ["src/w.ts"] }]);
    session("s-1", "impl-a", 2, 10, [{ minute: 0 }]);

    expect(report().fileReadData).toBe(false);
  });
});
