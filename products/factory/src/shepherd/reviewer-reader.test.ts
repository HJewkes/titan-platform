import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSourceFromPath, readSessionObservations, readSessionSourceText, type NormalizedSessionObservation } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptVerdict, type AwaitVerdictInput } from "./review.js";
import { reviewerMessages, transcriptReviewerReader, type TranscriptRow } from "./reviewer-reader.js";

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

const assistant = (sessionId: string, texts: readonly string[], timestamp: string | null = LATER): Json => ({
  type: "assistant",
  sessionId,
  uuid: `assistant-${texts[0]}`,
  ...(timestamp === null ? {} : { timestamp }),
  message: { id: `response-${texts[0]}`, role: "assistant", model: "claude-test", content: texts.map((text) => ({ type: "text", text })) },
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

  it.each(["live", "detached", "spawning"])("returns nothing while the agent is %s, because its turn may be unfinished", async (presence) => {
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
