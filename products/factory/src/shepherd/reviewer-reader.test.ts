import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSourceFromPath, readSessionObservations, readSessionSourceText, type NormalizedSessionObservation } from "@titan-design/session-read";
import type * as SessionRead from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPTH_FLOOR_REASON, INVESTIGATIVE_CALLS, isInvestigativeCall } from "./depth-floor.js";
import { seatFixFirst } from "./external-review.js";
import { acceptVerdict, type AwaitVerdictInput } from "./review.js";
import { reviewerMessages, sentMessages, transcriptReviewerReader, type TranscriptRow } from "./reviewer-reader.js";
import { toPresence, type Presence } from "./presence.js";

vi.mock("@titan-design/session-read", async (importOriginal) => {
  const original = await importOriginal<typeof SessionRead>();
  return { ...original, readSessionObservations: vi.fn(original.readSessionObservations) };
});

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
const readUse = (id: string): Json => ({ type: "tool_use", id, name: "Read", input: { file_path: "src/a.ts" } });

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

/** The reviewer reads one file, so its verdict clears the depth floor. */
const looked = (sessionId = SESSION): Json[] => [assistantRecord(sessionId, [readUse("tool-read")]), toolResult(sessionId, "tool-read", "export const a = 1;")];

const reviewed = (sessionId = SESSION) => [user(sessionId, "review it"), assistant(sessionId, [BLOCK])];

describe("transcriptReviewerReader", () => {
  it("returns each assistant text part of the finished session, oldest first, with a locator that reads back its text", async () => {
    const transcript = writeTranscript(SESSION, [user(SESSION, "review it"), assistant(SESSION, ["Reading.", "Still reading."]), user(SESSION, "go on"), ...looked(), assistant(SESSION, [BLOCK])]);

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

  it.each(["live", "detached", "exiting"] as const)("returns nothing while the presence is %s, because only exited proves the turn ended", async (presence) => {
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
    const transcript = writeTranscript(SESSION, [user(SESSION, "review it"), assistant(SESSION, ["Reading."]), ...looked(), assistantRecord(SESSION, [thinking, text(BLOCK)]), ...bookkeeping]);

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
  const seat = { name: "seat-a-4-review", agentId: "agent-seat-a-4-review", sessionId: FIXTURE_SESSION, presence: "exited" as const, spawnedBy: "coord", transcriptExists: true };
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

  it("blocks the head when an exited seat reviewer's transcript cannot be read", async () => {
    const rows = [{ ...seat, transcriptPath: path.join(dir, "gone", `${FIXTURE_SESSION}.jsonl`) }];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });

    const blocked = await seatFixFirst(async () => rows, reader, { repo: "octo/demo", pr: 4, head: FIXTURE_HEAD });

    expect(blocked).toMatchObject({ kind: "none", reason: expect.stringContaining(`the transcript of ${seat.name} could not be read`) });
  });

  it("does not block on a seat reviewer still running with no transcript yet", async () => {
    const rows = [{ ...seat, presence: "live" as const, transcriptExists: false, transcriptPath: null }];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });

    expect(await seatFixFirst(async () => rows, reader, { repo: "octo/demo", pr: 4, head: FIXTURE_HEAD })).toEqual({ kind: "clear" });
  });

  describe("a seat reviewer's transcript read by presence", () => {
    const FIX_FIRST_BLOCK = BLOCK.replace("Verdict: MERGE", "Verdict: FIX_FIRST");
    const PARTIAL = JSON.stringify(assistant(SESSION, ["On reflection"])).slice(0, 60);
    const sentOnly = [user(SESSION, "review it"), assistantRecord(SESSION, [sendVerdict(FIX_FIRST_BLOCK)])];
    const quiet = [user(SESSION, "review it"), assistant(SESSION, ["Reading."])];
    /** A MERGE on PR 7 at an older head, then more work: the transcript names its PR before it breaks. */
    const reviewingPr7 = [user(SESSION, "review it"), assistant(SESSION, [BLOCK.replace(HEAD, "b".repeat(40))]), assistant(SESSION, ["Looking again."])];

    /** The seat check over one transcript of `records`, with `partial` appended as an unterminated last record. */
    async function seatCheck(records: readonly Json[], presence: Presence, partial = false, pr = 7, warn = vi.fn()) {
      const transcript = writeTranscript(SESSION, records);
      if (partial) appendFileSync(transcript, PARTIAL, "utf8");
      const rows = [{ ...seat, sessionId: SESSION, presence, transcriptPath: transcript }];
      const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });
      return seatFixFirst(async () => rows, reader, { repo: "octo/demo", pr, head: HEAD }, warn);
    }

    it.each(["exited", "detached"] as const)("blocks on a FIX_FIRST sent by a %s reviewer whose transcript ends on the chat_send call", async (presence) => {
      expect(await seatCheck(sentOnly, presence)).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", head: HEAD });
    });

    it.each(["exited", "detached"] as const)("blocks its own PR with the failure named when a %s reviewer's transcript ends in a partial record", async (presence) => {
      expect(await seatCheck(reviewingPr7, presence, true)).toEqual({
        kind: "none",
        reason: `seat check: the transcript of ${seat.name} could not be read: DamagedTranscriptError`,
      });
    });

    it("blocks its own PR when a reviewer of unknown presence ends in a partial record, as a bare unlisted value did", async () => {
      expect(await seatCheck(reviewingPr7, toPresence("suspended"), true)).toEqual({
        kind: "none",
        reason: `seat check: the transcript of ${seat.name} could not be read: DamagedTranscriptError`,
      });
    });

    it("leaves another PR's MERGE standing and warns when an exited reviewer of PR 7 ends in a partial record", async () => {
      const warn = vi.fn();

      expect(await seatCheck(reviewingPr7, "exited", true, 8, warn)).toEqual({ kind: "clear" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${seat.name} is not the reviewer of octo/demo#8`));
    });

    it("blocks the PR its brief names when the reviewer was torn before any verdict, and leaves another PR clear", async () => {
      const briefed = [user(SESSION, "Review octo/demo#7 and send a verdict."), assistant(SESSION, ["Reading."])];

      expect(await seatCheck(briefed, "exited", true, 7)).toMatchObject({ kind: "none", reason: expect.stringContaining("could not be read: DamagedTranscriptError") });
      expect(await seatCheck(briefed, "exited", true, 8)).toEqual({ kind: "clear" });
    });

    it("does not block on a damaged transcript that names no PR, and warns", async () => {
      const warn = vi.fn();

      expect(await seatCheck(quiet, "exited", true, 7, warn)).toEqual({ kind: "clear" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not block it: DamagedTranscriptError"));
    });

    it("stays clear for a running reviewer whose last record is still being written", async () => {
      expect(await seatCheck(quiet, "live", true)).toEqual({ kind: "clear" });
    });

    it("blocks on a running reviewer's FIX_FIRST sent in a complete record before the partial one", async () => {
      expect(await seatCheck(sentOnly, "live", true)).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST" });
    });

    it("leaves the dispatched reviewer's read unchanged: a turn that ends on the call still reads as nothing", async () => {
      expect(await read([row(writeTranscript(SESSION, sentOnly), { agentId: seat.agentId })], sendRequest)).toEqual([]);
    });
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

describe("a seat reviewer's transcript read once per roster change", () => {
  const target = { repo: "octo/demo", pr: 7, head: HEAD };
  const seat = { name: "seat-a-1-review", agentId: "agent-seat-a-1-review", sessionId: SESSION, presence: "exited" as const, spawnedBy: "coord", transcriptExists: true };
  const reads = () => vi.mocked(readSessionObservations).mock.calls.length;

  beforeEach(() => vi.mocked(readSessionObservations).mockClear());

  it("reads the transcript once across two verdicts with an unchanged roster", async () => {
    const rows = [{ ...seat, transcriptPath: writeTranscript(SESSION, reviewed()) }];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });

    await seatFixFirst(async () => rows, reader, target);
    await seatFixFirst(async () => rows, reader, target);

    expect(reads()).toBe(1);
  });

  it("reads again when a new session appears under the same reviewer name", async () => {
    const first = { ...seat, transcriptPath: writeTranscript(SESSION, reviewed()) };
    const second = { ...seat, sessionId: "session-rv-2", transcriptPath: writeTranscript("session-rv-2", reviewed("session-rv-2")) };
    let rows = [first];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });

    await seatFixFirst(async () => rows, reader, target);
    rows = [first, second];
    await seatFixFirst(async () => rows, reader, target);

    expect(reads()).toBe(2);
  });

  it("reads again and sees the new FIX_FIRST when the transcript grew", async () => {
    const transcript = writeTranscript(SESSION, reviewed());
    const rows = [{ ...seat, transcriptPath: transcript }];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });
    expect(await seatFixFirst(async () => rows, reader, target)).toEqual({ kind: "clear" });

    const later = assistant(SESSION, [BLOCK.replace("MERGE", "FIX_FIRST")], "2026-09-30T10:09:00Z");
    appendFileSync(transcript, `${JSON.stringify(later)}\n`, "utf8");

    expect(await seatFixFirst(async () => rows, reader, target)).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST" });
    expect(reads()).toBe(2);
  });

  it("keeps a damaged transcript's veto from the cache without reading it again", async () => {
    const transcript = writeTranscript(SESSION, [user(SESSION, "Review octo/demo#7."), assistant(SESSION, ["Reading."])]);
    appendFileSync(transcript, JSON.stringify(assistant(SESSION, ["x"])).slice(0, 60), "utf8");
    const rows = [{ ...seat, transcriptPath: transcript }];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });

    const first = await seatFixFirst(async () => rows, reader, target);
    const second = await seatFixFirst(async () => rows, reader, target);

    expect(first).toMatchObject({ kind: "none" });
    expect(second).toEqual(first);
    expect(reads()).toBe(1);
  });

  it("reads a reviewer again after the roster dropped it, because its cache entry was pruned", async () => {
    const retired = { ...seat, transcriptPath: writeTranscript(SESSION, reviewed()) };
    const other = { ...seat, agentId: "agent-other", sessionId: "session-rv-2", transcriptPath: writeTranscript("session-rv-2", reviewed("session-rv-2")) };
    let rows = [retired, other];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });

    await seatFixFirst(async () => rows, reader, target);
    rows = [other];
    await seatFixFirst(async () => rows, reader, target);
    const before = reads();
    rows = [retired, other];
    await seatFixFirst(async () => rows, reader, target);

    expect(reads() - before).toBe(1);
  });

  it("reads a damaged transcript again once it grows whole, and then sees its verdict", async () => {
    const transcript = writeTranscript(SESSION, [user(SESSION, "Review octo/demo#7."), assistant(SESSION, ["Reading."])]);
    appendFileSync(transcript, JSON.stringify(assistant(SESSION, ["x"])).slice(0, 60), "utf8");
    const rows = [{ ...seat, transcriptPath: transcript }];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });
    expect(await seatFixFirst(async () => rows, reader, target)).toMatchObject({ kind: "none" });

    const verdict = assistant(SESSION, [BLOCK.replace("MERGE", "FIX_FIRST")], "2026-09-30T10:09:00Z");
    writeFileSync(transcript, [user(SESSION, "Review octo/demo#7."), assistant(SESSION, ["Reading."]), verdict].map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");

    expect(await seatFixFirst(async () => rows, reader, target)).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST" });
  });

  it("retries after a read failure that is not damage, instead of caching the failure", async () => {
    const rows = [{ ...seat, transcriptPath: writeTranscript(SESSION, reviewed()) }];
    const reader = transcriptReviewerReader({ roster: async () => rows, namespace: NAMESPACE });
    vi.mocked(readSessionObservations).mockImplementationOnce(() => {
      throw new Error("disk hiccup");
    });

    const request = { ...input, reviewerAgentId: seat.agentId };

    await expect(reader.readSeat!(request)).rejects.toThrow("disk hiccup");
    expect(await reader.readSeat!(request)).not.toEqual([]);
    expect(reads()).toBe(2);
  });
});

describe("an owner brief beside the verdict", () => {
  const BRIEF = ["OWNER-BRIEF", "What: Adds a widget retry.", "Why: It reaches the owner.", "Pros:", "- Fewer drops.", "Cons:", "- Timing is unreviewed.", "Door: two-way", "END-OWNER-BRIEF"].join("\n");
  const accepted = async (message: string) => {
    const messages = await read([row(writeTranscript(SESSION, [user(SESSION, "review it"), ...looked(), assistant(SESSION, [message])]))]);
    return acceptVerdict(input, messages);
  };

  it("is stored on the accepted verdict as typed fields", async () => {
    const result = await accepted(`${BLOCK}\n${BRIEF}\n`);

    expect(result).toMatchObject({ kind: "verdict", verdict: "MERGE", ownerBrief: { what: "Adds a widget retry.", pros: ["Fewer drops."], cons: ["Timing is unreviewed."], doorType: "two-way" } });
  });

  it("is null when the reviewer wrote none, and the verdict is the same", async () => {
    expect(await accepted(BLOCK)).toMatchObject({ kind: "verdict", verdict: "MERGE", head: HEAD, ownerBrief: null });
  });

  it("is null when malformed, and the verdict and its locator are unchanged", async () => {
    const plain = await accepted(BLOCK);
    const malformed = await accepted(`${BLOCK}\n${BRIEF.replace("two-way", "sideways")}\n`);

    expect(malformed).toMatchObject({ kind: "verdict", verdict: "MERGE", head: HEAD, ownerBrief: null });
    expect(malformed.kind === "verdict" && plain.kind === "verdict" && malformed.locator.selector).toEqual(plain.kind === "verdict" && plain.locator.selector);
  });
});

describe("the review depth floor", () => {
  const FIX_FIRST = BLOCK.replace("MERGE", "FIX_FIRST");
  const bash = (id: string, command: string): Json => ({ type: "tool_use", id, name: "Bash", input: { command } });
  const ran = (call: Json): Json[] => [assistantRecord(SESSION, [call]), toolResult(SESSION, call.id as string, "output")];
  const judged = async (records: readonly Json[]) => acceptVerdict(input, await read([row(writeTranscript(SESSION, [user(SESSION, "review it"), ...records]))]));

  it("sets aside a MERGE from a session that made no tool call at all", async () => {
    expect(await judged([assistant(SESSION, [BLOCK])])).toEqual({ kind: "none", reason: DEPTH_FLOOR_REASON });
  });

  it("sets aside a FIX_FIRST from a session that made no tool call at all", async () => {
    expect(await judged([assistant(SESSION, [FIX_FIRST])])).toEqual({ kind: "none", reason: DEPTH_FLOOR_REASON });
  });

  it("keeps a MERGE from a session that read one file first", async () => {
    expect(await judged([...looked(), assistant(SESSION, [BLOCK])])).toMatchObject({ kind: "verdict", verdict: "MERGE", head: HEAD });
  });

  it("keeps a MERGE from a session whose only call was a Bash read verb", async () => {
    expect(await judged([...ran(bash("tool-diff", "git diff main...HEAD")), assistant(SESSION, [BLOCK])])).toMatchObject({ kind: "verdict", verdict: "MERGE" });
  });

  it("sets aside a MERGE whose only calls run a command that reads nothing named in the floor", async () => {
    expect(await judged([...ran(bash("tool-test", "pnpm test")), ...ran(bash("tool-cat", "category list")), assistant(SESSION, [BLOCK])])).toEqual({ kind: "none", reason: DEPTH_FLOOR_REASON });
  });
});

describe("isInvestigativeCall", () => {
  const observed = async (call: Json) => {
    const observations: NormalizedSessionObservation[] = [];
    const transcript = writeTranscript(SESSION, [assistantRecord(SESSION, [call])], String(call.id));
    for await (const observation of readSessionObservations(claudeSourceFromPath(transcript, NAMESPACE))) observations.push(observation);
    return observations.filter((observation) => observation.kind === "tool_call").map(isInvestigativeCall);
  };

  it("counts each named read tool and each Bash read verb", async () => {
    const calls = [...INVESTIGATIVE_CALLS.tools.map((name) => ({ type: "tool_use", id: `t-${name}`, name, input: {} })), ...INVESTIGATIVE_CALLS.bashVerbs.map((verb, index) => ({ type: "tool_use", id: `b-${index}`, name: "Bash", input: { command: `  ${verb} x` } }))];

    const counted = (await Promise.all(calls.map((call) => observed(call)))).flat();

    expect(counted).toEqual(calls.map(() => true));
  });

  it("does not count a write, an agent-chat call or a Bash command outside the read verbs", async () => {
    const calls = [
      { type: "tool_use", id: "w", name: "Write", input: { file_path: "a.ts", content: "" } },
      { type: "tool_use", id: "c", name: "mcp__plugin_agent-chat_agent-chat__chat_send", input: { to: "coord", text: "hi" } },
      { type: "tool_use", id: "g", name: "Bash", input: { command: "git push origin HEAD" } },
      { type: "tool_use", id: "r", name: "Bash", input: { command: "rgx" } },
    ];

    const counted = (await Promise.all(calls.map((call) => observed(call)))).flat();

    expect(counted).toEqual([false, false, false, false]);
  });

  const bashCommand = async (command: string) => (await observed({ type: "tool_use", id: "x", name: "Bash", input: { command } }))[0];

  it.each([
    "cd /tmp/review-1-x && grep -rn foo src",
    "dir=/tmp/r1 && git fetch origin && git -C \"$dir\" diff main",
    "pnpm exec vitest run src/a.test.ts",
    "cd /tmp/r && FOO=1 pnpm vitest run",
    "git fetch origin; ls -la",
    "cd /tmp/r\ngit diff main",
    "grep -rn foo src | head -5",
    "cd x && npm run verify",
    "npm test",
    "node --test a.test.js",
    "git -C /tmp/r log --oneline",
    "git -C /tmp/r merge-tree a b",
    "git -C /tmp/r ls-files",
    "wc -l a && find . -name x && tail -n 3 a",
    "echo 'a && b' && grep 'x && y' f",
  ])("counts the reviewer shape %s", async (command) => {
    expect(await bashCommand(command)).toBe(true);
  });

  it.each([
    "cd /tmp/review-1-x",
    "echo hello",
    "git fetch origin",
    "rm -rf /tmp/review-1-x",
    "cd /tmp/r && mkdir -p out && echo done",
    "git worktree add /tmp/r origin/main && git fetch",
    "echo 'x && grep y'",
    "echo \"a ; cat b\"",
    "git fetch origin abc 2>&1 | tail -2",
    "git worktree add /tmp/x sha 2>&1 | tail -1",
    "echo hi | head -1",
    "git status | wc -l",
    "mkdir -p /tmp/x && ls",
  ])("does not count the session-setup shape %s", async (command) => {
    expect(await bashCommand(command)).toBe(false);
  });
});
