import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSourceFromPath, readSessionObservations, readSessionSourceText, type NormalizedSessionObservation } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seatFixFirst } from "./external-review.js";
import { acceptVerdict, type AwaitVerdictInput } from "./review.js";
import { reviewerMessages, sentMessages, transcriptReviewerReader, type TranscriptRow } from "./reviewer-reader.js";

const HEAD = "a".repeat(40);
const NAMESPACE = "host-a";
const SESSION = "session-rv-1";
const DISPATCHED = "2026-09-30T10:00:00Z";
const LATER = "2026-09-30T10:05:00Z";
const input: AwaitVerdictInput = {
  repo: "octo/demo",
  pr: 7,
  head: HEAD,
  reviewerAgentId: "agent-rv-1",
  reviewerSessionId: SESSION,
  dispatchedAt: Date.parse(DISPATCHED),
};
const BLOCK = `Looked at it.\n\nVerdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}\n`;

type Json = Record<string, unknown>;
type Row = TranscriptRow & { name?: string };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-reviewer-reader-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const user = (sessionId: string, text: string): Json => ({ type: "user", sessionId, uuid: `user-${text}`, timestamp: DISPATCHED, message: { role: "user", content: text } });

let recordCount = 0;

/** One assistant record as Claude Code writes it: a model on every record, and any mix of content blocks. */
const assistantRecord = (sessionId: string, content: readonly Json[], timestamp: string | null = LATER): Json => ({
  type: "assistant",
  sessionId,
  uuid: `assistant-${++recordCount}`,
  ...(timestamp === null ? {} : { timestamp }),
  message: { id: `response-${recordCount}`, role: "assistant", model: "claude-test", content },
});

/** An assistant record stripped to its content, so no model, id or timestamp can reveal it. */
const bareRecord = (sessionId: string, message: Json): Json => ({ type: "assistant", sessionId, message: { role: "assistant", ...message } });

const text = (value: string): Json => ({ type: "text", text: value });
const thinking: Json = { type: "thinking", thinking: "weighing it", signature: "synthetic" };
const toolUse = (id: string): Json => ({ type: "tool_use", id, name: "Bash", input: { command: "pnpm test" } });

const assistant = (sessionId: string, texts: readonly string[], timestamp: string | null = LATER): Json => assistantRecord(sessionId, texts.map(text), timestamp);

const toolResult = (sessionId: string, id: string, output: string): Json => ({
  type: "user",
  sessionId,
  uuid: `result-${++recordCount}`,
  timestamp: LATER,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
});

/** A transcript named after its session, as Claude Code writes it; `project` keeps two sessions of one name apart. */
function writeTranscript(sessionId: string, records: readonly Json[], project = "project"): string {
  const filePath = path.join(dir, project, `${sessionId}.jsonl`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  return filePath;
}

const row = (transcriptPath: string | null, overrides: Partial<Row> = {}): Row => ({
  agentId: input.reviewerAgentId,
  sessionId: SESSION,
  presence: "exited",
  transcriptPath,
  transcriptExists: true,
  ...overrides,
});

const read = (rows: readonly Row[], request: AwaitVerdictInput = input) =>
  transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE }).read(request);

const reviewed = (sessionId = SESSION) => [user(sessionId, "review it"), assistant(sessionId, [BLOCK])];

describe("transcriptReviewerReader", () => {
  it("returns each assistant text part of the finished session, oldest first, with a locator that reads back its text", async () => {
    const transcript = writeTranscript(SESSION, [user(SESSION, "review it"), assistant(SESSION, ["Reading.", "Still reading."]), user(SESSION, "go on"), assistant(SESSION, [BLOCK])]);

    const messages = await read([row(transcript)]);

    expect(messages.map((message) => message.text)).toEqual(["Reading.", "Still reading.", BLOCK]);
    expect(await Promise.all(messages.map((message) => readSessionSourceText(message.locator)))).toEqual(["Reading.", "Still reading.", BLOCK]);
    expect(messages.at(-1)).toMatchObject({ agentId: input.reviewerAgentId, sessionId: SESSION, writtenAt: Date.parse(LATER) });
    expect(messages.at(-1)!.locator.source.conversation).toEqual({ harness: "claude-code", namespace: NAMESPACE, nativeId: SESSION });
    expect(acceptVerdict(input, messages)).toMatchObject({ kind: "verdict", verdict: "MERGE", head: HEAD });
  });

  it("names the machine by its hostname when no namespace is given", async () => {
    const transcript = writeTranscript(SESSION, reviewed());

    const messages = await transcriptReviewerReader({ roster: async () => [row(transcript)] }).read(input);

    expect(messages.at(-1)!.locator.source.namespace).toBe(os.hostname());
  });

  it.each(["live", "detached", "exiting"])("returns nothing while the presence is %s, because only exited proves the turn ended", async (presence) => {
    const transcript = writeTranscript(SESSION, reviewed());

    expect(await read([row(transcript, { presence })])).toEqual([]);
  });

  it("finds the reviewer by agent id when an earlier agent holds the same name", async () => {
    const earlier = writeTranscript(SESSION, [assistant(SESSION, ["earlier agent"])], "earlier");
    const transcript = writeTranscript(SESSION, reviewed());

    const messages = await read([row(earlier, { name: "rv-demo-7", agentId: "agent-rv-0" }), row(transcript, { name: "rv-demo-7" })]);

    expect(messages.map((message) => message.text)).toEqual([BLOCK]);
  });

  it("returns nothing when only an agent's name equals the reviewer's agent id", async () => {
    const transcript = writeTranscript(SESSION, reviewed());

    expect(await read([row(transcript, { name: input.reviewerAgentId, agentId: "agent-rv-0" })])).toEqual([]);
  });

  it("attributes messages to the session the transcript belongs to, not the one the roster claims", async () => {
    const other = writeTranscript("session-other", reviewed("session-other"));

    const messages = await read([row(other)]);

    expect(messages.map((message) => message.sessionId)).toEqual(["session-other"]);
    expect(acceptVerdict(input, messages)).toEqual({ kind: "none" });
  });

  it("returns nothing when the agent now runs another session than the dispatched one", async () => {
    const transcript = writeTranscript("session-rv-2", reviewed("session-rv-2"));

    expect(await read([row(transcript, { sessionId: "session-rv-2" })])).toEqual([]);
  });

  it("keeps a final message that has no timestamp, so an earlier block is never promoted to final", async () => {
    const transcript = writeTranscript(SESSION, [user(SESSION, "review it"), assistant(SESSION, [BLOCK]), assistant(SESSION, ["On reflection, do not merge."], null)]);

    const messages = await read([row(transcript)]);

    expect(messages.at(-1)).toMatchObject({ text: "On reflection, do not merge.", writtenAt: Number.NaN });
    expect(acceptVerdict(input, messages)).toEqual({ kind: "none" });
  });

  it("returns messages in file order with each one's own timestamp, even when the timestamps disagree", async () => {
    const stamps = ["2026-09-30T10:05:00Z", "2026-09-30T10:03:00Z", "2026-09-30T10:04:00Z"];
    const transcript = writeTranscript(SESSION, stamps.map((stamp, index) => assistant(SESSION, [`message ${index}`], stamp)));

    const messages = await read([row(transcript)]);

    expect(messages.map((message) => message.text)).toEqual(["message 0", "message 1", "message 2"]);
    expect(messages.map((message) => message.writtenAt)).toEqual(stamps.map((stamp) => Date.parse(stamp)));
  });

  it("gives a malformed timestamp no time at all, so the message cannot count as written after dispatch", async () => {
    const transcript = writeTranscript(SESSION, [assistant(SESSION, [BLOCK], "not-a-date")]);

    const messages = await read([row(transcript)]);

    expect(messages.map((message) => message.writtenAt)).toEqual([Number.NaN]);
    expect(acceptVerdict(input, messages)).toEqual({ kind: "none" });
  });

  it("returns nothing when the transcript ends in a truncated record, because a later message is still being written", async () => {
    const transcript = writeTranscript(SESSION, reviewed());
    appendFileSync(transcript, JSON.stringify(assistant(SESSION, ["On reflection: do NOT merge."])).slice(0, 60), "utf8");

    expect(await read([row(transcript)])).toEqual([]);
  });

  it("returns nothing when the last record is complete but has no trailing newline", async () => {
    const transcript = writeTranscript(SESSION, reviewed());
    appendFileSync(transcript, JSON.stringify(assistant(SESSION, ["On reflection: do NOT merge."])), "utf8");

    expect(await read([row(transcript)])).toEqual([]);
  });

  it.each<[string, readonly Json[]]>([
    ["a tool call in the same record", [assistantRecord(SESSION, [text(BLOCK), toolUse("tool-1")])]],
    ["thinking after the text in the same record", [assistantRecord(SESSION, [text(BLOCK), thinking])]],
    ["a tool call in the next record", [assistant(SESSION, [BLOCK]), assistantRecord(SESSION, [toolUse("tool-1")])]],
    ["a tool result", [assistant(SESSION, [BLOCK]), assistantRecord(SESSION, [toolUse("tool-1")]), toolResult(SESSION, "tool-1", "ok")]],
    [
      "a failed tool result and another tool call",
      [assistant(SESSION, [BLOCK]), assistantRecord(SESSION, [toolUse("tool-1")]), toolResult(SESSION, "tool-1", "3 tests FAILED"), assistantRecord(SESSION, [toolUse("tool-2")])],
    ],
    ["a user message", [assistant(SESSION, [BLOCK]), user(SESSION, "head moved, review again")]],
    ["a thinking-only record", [assistant(SESSION, [BLOCK]), assistantRecord(SESSION, [thinking])]],
    ["an empty-text record", [assistant(SESSION, [BLOCK]), assistantRecord(SESSION, [text("")])]],
    ["a bare tool call record", [assistant(SESSION, [BLOCK]), bareRecord(SESSION, { content: [toolUse("tool-1")] })]],
    ["a bare thinking-only record", [assistant(SESSION, [BLOCK]), bareRecord(SESSION, { content: [thinking] })]],
    ["a bare empty-text record that reports usage", [assistant(SESSION, [BLOCK]), bareRecord(SESSION, { content: [text("")], usage: { input_tokens: 1, output_tokens: 1 } })]],
  ])("returns nothing when the block is followed by %s, because the turn did not end on it", async (_shape, records) => {
    const transcript = writeTranscript(SESSION, [user(SESSION, "review it"), ...records]);

    expect(await read([row(transcript)])).toEqual([]);
  });

  it("still returns the final text when only thinking precedes it and only bookkeeping records follow it", async () => {
    const bookkeeping: Json[] = [
      { type: "system", subtype: "stop_hook_summary", sessionId: SESSION, cwd: "/workspace/demo", hookCount: 1, timestamp: LATER },
      { type: "last-prompt", sessionId: SESSION, lastPrompt: "review it" },
      { type: "file-history-snapshot", sessionId: SESSION },
    ];
    const transcript = writeTranscript(SESSION, [user(SESSION, "review it"), assistant(SESSION, ["Reading."]), assistantRecord(SESSION, [thinking, text(BLOCK)]), ...bookkeeping]);

    const messages = await read([row(transcript)]);

    expect(messages.map((message) => message.text)).toEqual(["Reading.", BLOCK]);
    expect(acceptVerdict(input, messages)).toMatchObject({ kind: "verdict", verdict: "MERGE" });
  });

  it.each([{ transcriptExists: false }, { transcriptPath: null }])("returns nothing when the roster has no transcript (%o)", async (missing) => {
    const transcript = writeTranscript(SESSION, reviewed());

    expect(await read([row(transcript, missing)])).toEqual([]);
  });

  it("returns nothing when no agent has the reviewer's agent id", async () => {
    expect(await read([])).toEqual([]);
  });

  it("rejects when the transcript the roster names cannot be read", async () => {
    await expect(read([row(path.join(dir, "project", `${SESSION}.jsonl`))])).rejects.toThrow();
  });

  it("rejects a transcript that carries a record of another session", async () => {
    const transcript = writeTranscript(SESSION, [assistant("session-earlier", [BLOCK]), ...reviewed()]);

    await expect(read([row(transcript)])).rejects.toThrow(/contains session session-earlier/);
  });
});

describe("reviewerMessages", () => {
  const observed = async (records: readonly Json[]): Promise<NormalizedSessionObservation[]> => {
    const observations: NormalizedSessionObservation[] = [];
    for await (const observation of readSessionObservations(claudeSourceFromPath(writeTranscript(SESSION, records), NAMESPACE))) observations.push(observation);
    return observations;
  };

  it("excludes history copied in from another conversation", async () => {
    const message = (await observed(reviewed())).find((observation) => observation.kind === "message" && observation.role === "assistant")!;
    const copied = { ...message, historyOrigin: { harness: "claude-code", namespace: NAMESPACE, nativeId: "session-earlier" } };

    expect(reviewerMessages("agent-rv-1", message).map((part) => part.text)).toEqual([BLOCK]);
    expect(reviewerMessages("agent-rv-1", copied)).toEqual([]);
  });

  it("excludes user messages, even one that holds a block", async () => {
    const observations = await observed([user(SESSION, BLOCK)]);

    expect(observations.some((observation) => observation.kind === "message")).toBe(true);
    expect(observations.flatMap((observation) => reviewerMessages("agent-rv-1", observation))).toEqual([]);
  });
});

describe("a seat reviewer that sends its verdict with chat_send", () => {
  /** Trimmed from a real seat reviewer transcript; ids, paths and text are synthetic, the record shapes are as Claude Code wrote them. */
  const FIXTURE_SESSION = "5e47c0de-0000-4000-8000-000000000001";
  const FIXTURE_HEAD = `c0ffee${"0".repeat(34)}`;
  const seat = { name: "seat-a-4-review", agentId: "agent-seat-a-4-review", sessionId: FIXTURE_SESSION, presence: "exited", spawnedBy: "coord", transcriptExists: true };
  const sendVerdict = (verdict: string): Json => ({ type: "tool_use", id: "tool-send", name: "mcp__plugin_agent-chat_agent-chat__chat_send", input: { to: "coord", text: verdict } });
  const sendRequest = { ...input, reviewerAgentId: seat.agentId };

  it("reads the FIX_FIRST from a real transcript's chat_send input, so the seat check blocks the head", async () => {
    const transcript = path.join(dir, "project", `${FIXTURE_SESSION}.jsonl`);
    mkdirSync(path.dirname(transcript), { recursive: true });
    copyFileSync(new URL(`./fixtures/${FIXTURE_SESSION}.jsonl`, import.meta.url), transcript);
    const rows = [{ ...seat, transcriptPath: transcript }];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });

    const blocked = await seatFixFirst(async () => rows, reader, { repo: "octo/demo", pr: 4, head: FIXTURE_HEAD });

    expect(blocked).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", head: FIXTURE_HEAD, reviewer: { agentId: seat.agentId, sessionId: FIXTURE_SESSION } });
    expect(blocked.kind === "verdict" && (await readSessionSourceText(blocked.locator))).toMatch(/^Verdict: FIX_FIRST\nPR: octo\/demo#4/);
  });

  it("keeps the final text last, so the dispatched reviewer's final message is still its text", async () => {
    const records = [user(SESSION, "review it"), assistantRecord(SESSION, [sendVerdict(BLOCK)]), toolResult(SESSION, "tool-send", "Delivered."), assistant(SESSION, ["Sent it."])];

    const messages = await read([row(writeTranscript(SESSION, records), { agentId: seat.agentId })], sendRequest);

    expect(messages.map((message) => message.text)).toEqual([BLOCK, "Sent it."]);
  });

  it("returns nothing when the turn ends on the chat_send call, because its result has not come back", async () => {
    const records = [user(SESSION, "review it"), assistantRecord(SESSION, [sendVerdict(BLOCK)])];

    expect(await read([row(writeTranscript(SESSION, records), { agentId: seat.agentId })], sendRequest)).toEqual([]);
  });

  it("ignores a text input to a tool that is not chat_send", async () => {
    const observations: NormalizedSessionObservation[] = [];
    const other = assistantRecord(SESSION, [{ type: "tool_use", id: "tool-1", name: "Write", input: { text: BLOCK } }]);
    for await (const observation of readSessionObservations(claudeSourceFromPath(writeTranscript(SESSION, [other]), NAMESPACE))) observations.push(observation);

    expect(observations.some((observation) => observation.kind === "tool_call")).toBe(true);
    expect(observations.flatMap((observation) => sentMessages("agent-rv-1", observation))).toEqual([]);
  });
});
