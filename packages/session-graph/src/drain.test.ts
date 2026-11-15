import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRAIN_SCREENED_MIGRATION, DRAIN_TEMPLATE_MIGRATION, ingestDrain, listTemplates } from "./drain.js";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { indexTranscript } from "./refresh.js";

const REPO = path.join(os.tmpdir(), "titan-session-graph-drain-repo");
mkdirSync(path.join(REPO, ".git"), { recursive: true });
writeFileSync(path.join(REPO, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/demo.git\n');

const base = (fields: Record<string, unknown>) => ({ sessionId: "s1", cwd: REPO, gitBranch: "main", ...fields });
const call = (ts: string, id: string) =>
  base({ type: "assistant", timestamp: ts, requestId: `req-${ts}`, message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "tool_use", id, name: "Bash", input: { command: "pnpm test" } }] } });
const result = (ts: string, id: string, text: string) =>
  base({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } });
const typeError = (file: string, prop: string) => `FAIL ${file}\nTypeError: Cannot read properties of undefined (reading '${prop}')\n  at Object.<anonymous> (${file}:10:5)`;
const render = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

let dir: string;
let file: string;
let graph: SessionGraph;

async function index(lines: unknown[]): Promise<void> {
  writeFileSync(file, render(lines));
  const transcript: DiscoveredTranscript = { projectDir: "p", absolutePath: file, displayPath: file, subagentId: null, account: null };
  await indexTranscript(graph, transcript);
}

const FIRST_ERROR = [call("2026-07-01T00:00:01Z", "t1"), result("2026-07-01T00:00:02Z", "t1", typeError("src/a.test.ts", "x"))];
const SECOND_ERROR = [call("2026-07-01T00:00:03Z", "t2"), result("2026-07-01T00:00:04Z", "t2", typeError("src/b.test.ts", "y"))];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-drain-"));
  file = path.join(dir, "s1.jsonl");
  graph = openSessionGraph(":memory:");
  runMigrations(graph.db, [DRAIN_TEMPLATE_MIGRATION, DRAIN_SCREENED_MIGRATION]);
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ingestDrain", () => {
  it("clusters an error fact into a new template", async () => {
    await index(FIRST_ERROR);

    const summary = await ingestDrain(graph, {});

    expect(summary).toEqual({ candidates: 1, screened: 0, clustered: 1, newTemplates: 1, templates: 1, unreadable: 0 });
    expect(listTemplates(graph, 5)).toEqual([expect.objectContaining({ occurrenceCount: 1, maskedSignature: expect.stringContaining("TypeError") })]);
  });

  it("raises the occurrence count when a repeat error lands on an existing template", async () => {
    await index(FIRST_ERROR);
    await ingestDrain(graph, {});
    await index([...FIRST_ERROR, ...SECOND_ERROR]);

    const summary = await ingestDrain(graph, {});

    expect(summary).toMatchObject({ candidates: 1, clustered: 1, newTemplates: 0, templates: 1 });
    expect(listTemplates(graph, 5)).toEqual([expect.objectContaining({ occurrenceCount: 2 })]);
  });

  it("records a non-error tool result as screened and skips it on the next pass", async () => {
    await index([call("2026-07-01T00:00:01Z", "t1"), result("2026-07-01T00:00:02Z", "t1", "all good, nothing to report")]);

    const first = await ingestDrain(graph, {});
    const again = await ingestDrain(graph, {});

    expect(first).toMatchObject({ candidates: 1, screened: 1, clustered: 0, templates: 0 });
    expect(again.candidates).toBe(0);
    expect(graph.db.prepare("SELECT count(*) AS n FROM drain_screened").get()).toEqual({ n: 1 });
  });

  it("restores the clusterer snapshot across passes so a repeat keeps the template id", async () => {
    await index(FIRST_ERROR);
    await ingestDrain(graph, {});
    const before = graph.db.prepare("SELECT template_id FROM template").all();
    await index([...FIRST_ERROR, ...SECOND_ERROR]);

    await ingestDrain(graph, {});

    expect(graph.db.prepare("SELECT count(*) AS n FROM clusterer_snapshot").get()).toEqual({ n: 1 });
    expect(graph.db.prepare("SELECT template_id FROM template").all()).toEqual(before);
    expect(graph.db.prepare("SELECT DISTINCT template_id FROM occurrence").all()).toEqual(before);
  });

  it("counts a span whose transcript file is gone as unreadable", async () => {
    await index(FIRST_ERROR);
    rmSync(file);

    const summary = await ingestDrain(graph, {});

    expect(summary).toMatchObject({ candidates: 1, unreadable: 1, clustered: 0, templates: 0 });
  });
});
