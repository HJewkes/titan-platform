import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prefixHash } from "@titan-design/locator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_CWD, FIXTURE_LINES, SESSION, offsetAfterLine, renderTranscript } from "./fixture.js";
import type { TranscriptDelta } from "./fold.js";
import { TranscriptParseError, extractTranscript, readTranscriptEvents } from "./read.js";

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-read-"));
  transcript = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, renderTranscript(FIXTURE_LINES), "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const relationsOf = (delta: TranscriptDelta) => delta.edges.map((e) => `${e.sourceRef} ${e.relation} ${e.targetRef}`);

describe("extractTranscript", () => {
  it("emits one fact per non-blank line, tagged by event type", async () => {
    const result = await extractTranscript(transcript);
    expect(result.facts).toHaveLength(FIXTURE_LINES.length);
    const types = new Set(result.facts.map((f) => f.eventType));
    for (const t of ["user_prompt", "tool_decision", "assistant_response", "tool_result_error", "pr_link", "system_compact_boundary"]) {
      expect(types, t).toContain(t);
    }
  });

  it("folds session metadata, turns, and per-model token buckets", async () => {
    const result = await extractTranscript(transcript);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "sess-1",
      aiTitle: "Demo session",
      seedPrompt: "seed the demo",
      cwd: FIXTURE_CWD,
      gitBranch: "feat/x",
      startedAt: "2026-07-01T00:00:00Z",
      endedAt: "2026-07-01T00:00:19Z",
      turnDelta: 9,
      commitDelta: 1,
    });
    expect(result.turns.map((t) => t.promptId)).toEqual(["p1", "p2"]);
    expect(result.usage).toEqual([
      expect.objectContaining({
        sessionId: "sess-1",
        model: "claude-opus-5",
        inputTokens: 90,
        outputTokens: 180,
        cacheReadTokens: 45,
        cacheCreationTokens: 18,
        // 'hmm' (3 chars) against 8 chars of generated content on that line: round(20 * 3/8).
        thinkingTokens: 8,
        requestCount: 9,
      }),
    ]);
  });

  it("extracts assets and relations while skipping ignored paths", async () => {
    const result = await extractTranscript(transcript);
    expect(result.files.map((f) => f.fileRef)).toEqual(["file:demo/src/app.ts"]);
    expect(result.prs[0]).toMatchObject({ prRef: "pr:acme/demo#42", number: 42, repo: "acme/demo" });
    expect(result.prMerges).toEqual([expect.objectContaining({ number: 42, repoHint: "demo", ts: "2026-07-01T00:00:16Z" })]);
    expect(result.branches.map((b) => b.branchRef).sort()).toEqual(["branch:demo/feat/x", "branch:demo/feat/y"]);
    expect(result.branches.find((b) => b.name === "feat/y")?.createdAt).toBe("2026-07-01T00:00:12Z");
    expect(result.tasks.map((t) => t.taskRef)).toEqual(["task:AW-23"]);
    expect(result.subagents[0]).toMatchObject({ agentRef: "agent:t3", agentType: "Explore" });
    expect(result.artifacts.map((a) => a.artifactRef).sort()).toEqual(["artifact:https://frames/1", "artifact:t5"]);
    expect(result.humanEdits).toHaveLength(1);
    expect(result.fileCheckpoints).toEqual([
      expect.objectContaining({ sessionId: "sess-1", filePath: "src/app.ts", backupFileName: "abc123@v1", version: 1 }),
    ]);

    const relations = relationsOf(result);
    expect(relations).toContain("session:sess-1 touched file:demo/src/app.ts");
    expect(relations).toContain("session:sess-1 linked pr:acme/demo#42");
    expect(relations).toContain("session:sess-1 worked branch:demo/feat/y");
    expect(relations).toContain("session:sess-1 ran task:AW-23");
    expect(relations).toContain("session:sess-1 spawned agent:t3");
    expect(relations).toContain("session:sess-1 edited_by_human file:demo/src/app.ts");
    expect(relations.filter((r) => r.includes("pr:acme/demo#42"))).toEqual(["session:sess-1 linked pr:acme/demo#42"]);
  });

  it("records both mode and permission-mode phase candidates", async () => {
    const result = await extractTranscript(transcript);
    expect(result.phases).toEqual([
      expect.objectContaining({ trigger: "mode", toMode: "plan" }),
      expect.objectContaining({ trigger: "permission-mode", toMode: "acceptEdits" }),
    ]);
  });

  it("resumes from a watermark and re-reads from zero when the prefix hash mismatches", async () => {
    const watermark = offsetAfterLine(FIXTURE_LINES, 5);
    const hash = await prefixHash(transcript, watermark);
    const delta = await extractTranscript(transcript, { fromByteOffset: watermark, priorPrefixHash: hash });
    expect(delta).toMatchObject({ restartedFromZero: false, startByteOffset: watermark });
    expect(delta.facts).toHaveLength(FIXTURE_LINES.length - 5);
    expect(delta.facts.every((f) => f.byteOffset >= watermark)).toBe(true);
    expect(delta.turns.map((t) => t.promptId)).toEqual(["p2"]);

    const rewound = await extractTranscript(transcript, { fromByteOffset: watermark, priorPrefixHash: "stale" });
    expect(rewound).toMatchObject({ restartedFromZero: true, startByteOffset: 0 });
    expect(rewound.facts).toHaveLength(FIXTURE_LINES.length);
  });

  it("throws a locating error for a malformed line", async () => {
    writeFileSync(transcript, '{"sessionId":"s"}\nnot json\n', "utf8");
    await expect(extractTranscript(transcript)).rejects.toBeInstanceOf(TranscriptParseError);
  });

  it("produces the same rows chunked as in one full pass", async () => {
    const split = offsetAfterLine(FIXTURE_LINES, 8);
    const full = await extractTranscript(transcript);
    const first = await extractTranscript(transcript, { untilByteOffset: split });
    const second = await extractTranscript(transcript, { fromByteOffset: first.lastByteOffset, priorPrefixHash: first.prefixHash });
    expect(first.lastByteOffset).toBe(split);
    expect(second.restartedFromZero).toBe(false);

    const keys = ["facts", "spans", "phases", "humanEdits", "fileCheckpoints", "prMerges", "prCreates"] as const;
    for (const kind of keys) {
      expect(sortedJson([...first[kind], ...second[kind]]), kind).toEqual(sortedJson(full[kind]));
    }
    expect(dedupe([...first.edges, ...second.edges], (e) => `${e.sourceRef} ${e.relation} ${e.targetRef}`)).toHaveLength(full.edges.length);
    expect(dedupe([...first.files, ...second.files], (f) => f.fileRef).map((f) => f.fileRef)).toEqual(full.files.map((f) => f.fileRef));
    expect(first.usage[0]!.requestCount + second.usage[0]!.requestCount).toBe(full.usage[0]!.requestCount);
  });

  it("gives a subagent sidechain its own identity and links it to the parent", async () => {
    const sidechain = path.join(dir, "agent-abc.jsonl");
    writeFileSync(sidechain, renderTranscript(FIXTURE_LINES.slice(4, 7)), "utf8");
    const events = [];
    for await (const e of readTranscriptEvents(sidechain, { subagentId: "abc" })) events.push(e);
    expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set(["abc"]));
    const spawned = events.filter((e) => e.kind === "edge" && e.relation === "spawned");
    expect(spawned[0]).toMatchObject({ sourceRef: "session:sess-1", targetRef: "session:abc" });
  });
});

function sortedJson(rows: unknown[]): string[] {
  return rows.map((r) => JSON.stringify(r)).sort();
}

function dedupe<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) if (!seen.has(keyOf(row))) seen.set(keyOf(row), row);
  return [...seen.values()];
}
