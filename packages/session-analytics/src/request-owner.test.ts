import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertRequest, insertSignal, insertToolCall, type FixtureGraph } from "./fixture.js";
import { readRequestToolCalls } from "./request-owner.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
});
afterEach(() => fixture.close());

const WINDOW = { since: "2026-09-20", until: "2026-09-21" };
const at = (minute: number) => `2026-09-20T10:${String(minute).padStart(2, "0")}:00Z`;

describe("readRequestToolCalls", () => {
  it("gives a tool call to the request before it, not the request it feeds", () => {
    const db = fixture.graph.db;
    insertRequest(db, { sessionId: "s", transcriptId: 7, requestId: "first", ts: at(0), offset: 100 });
    insertToolCall(db, { sessionId: "s", transcriptId: 7, ts: at(0), toolUseId: "tu-same-line", name: "Read", offset: 100, blockIndex: 1 });
    insertToolCall(db, { sessionId: "s", transcriptId: 7, ts: at(0), toolUseId: "tu-between", name: "Bash", offset: 150 });
    insertRequest(db, { sessionId: "s", transcriptId: 7, requestId: "second", ts: at(1), offset: 200 });

    const calls = readRequestToolCalls(fixture.openReadOnly(), WINDOW);

    expect(calls.get("first")?.map((call) => call.tool)).toEqual(["Read", "Bash"]);
    expect(calls.has("second")).toBe(false);
  });

  it("drops the tool calls of a fan-out copy of a request", () => {
    const db = fixture.graph.db;
    insertRequest(db, { sessionId: "s", transcriptId: 1, requestId: "r", ts: at(0), offset: 10 });
    insertToolCall(db, { sessionId: "s", transcriptId: 1, ts: at(0), toolUseId: "tu-1", name: "Bash", offset: 11 });
    insertRequest(db, { sessionId: "s", transcriptId: 2, requestId: "r", ts: at(5), offset: 10 });
    insertToolCall(db, { sessionId: "s", transcriptId: 2, ts: at(5), toolUseId: "tu-1", name: "Bash", offset: 11 });
    insertRequest(db, { sessionId: "s", transcriptId: 2, requestId: "fork-own", ts: at(6), offset: 20 });
    insertToolCall(db, { sessionId: "s", transcriptId: 2, ts: at(6), toolUseId: "tu-2", name: "Read", offset: 21 });

    const calls = readRequestToolCalls(fixture.openReadOnly(), WINDOW);

    expect(calls.get("r")).toEqual([{ tool: "Bash" }]);
    expect(calls.get("fork-own")).toEqual([{ tool: "Read" }]);
  });

  it("attaches the heads and paths session-read extracted for each call", () => {
    const db = fixture.graph.db;
    insertRequest(db, { sessionId: "s", transcriptId: 3, requestId: "r", ts: at(0), offset: 10 });
    insertToolCall(db, { sessionId: "s", transcriptId: 3, ts: at(0), toolUseId: "tu-bash", name: "Bash", offset: 11 });
    insertSignal(db, { sessionId: "s", transcriptId: 3, ts: at(0), signal: "command_heads", detail: "gh pr checks;echo;>log.jsonl", toolUseId: "tu-bash", offset: 11 });
    insertSignal(db, { sessionId: "s", transcriptId: 3, ts: at(0), signal: "commit", detail: "x", toolUseId: "tu-bash", offset: 12 });
    insertToolCall(db, { sessionId: "s", transcriptId: 3, ts: at(0), toolUseId: "tu-read", name: "Read", offset: 13 });
    insertSignal(db, { sessionId: "s", transcriptId: 3, ts: at(0), signal: "file_read", detail: "src/a.ts", toolUseId: "tu-read", offset: 13 });
    insertToolCall(db, { sessionId: "s", transcriptId: 3, ts: at(0), toolUseId: "tu-edit", name: "Edit", offset: 14 });
    insertSignal(db, { sessionId: "s", transcriptId: 3, ts: at(0), signal: "file_write", detail: "notes/log.md", toolUseId: "tu-edit", offset: 14 });

    const calls = readRequestToolCalls(fixture.openReadOnly(), WINDOW);

    expect(calls.get("r")).toEqual([
      { tool: "Bash", heads: ["gh pr checks", "echo", ">log.jsonl"] },
      { tool: "Read", readPaths: ["src/a.ts"] },
      { tool: "Edit", writePaths: ["notes/log.md"] },
    ]);
  });

  it("leaves out requests outside the window", () => {
    const db = fixture.graph.db;
    insertRequest(db, { sessionId: "s", transcriptId: 4, requestId: "late", ts: "2026-09-21T00:00:00Z", offset: 10 });
    insertToolCall(db, { sessionId: "s", transcriptId: 4, ts: "2026-09-21T00:00:00Z", toolUseId: "tu", name: "Read", offset: 11 });

    expect(readRequestToolCalls(fixture.openReadOnly(), WINDOW).size).toBe(0);
  });
});
