import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_FIXTURE_LINES, SESSION, offsetAfterLine, renderTranscript } from "./fixture.js";
import { extractTranscript } from "./read.js";

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-read-inbound-"));
  transcript = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, renderTranscript(AUDIT_FIXTURE_LINES), "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("inbound emitter", () => {
  it("a channel message user line emits inbound channel_message turn_start with from and msg_id", async () => {
    const { inbound } = await extractTranscript(transcript);
    const channel = inbound.filter((i) => i.ts === "2026-07-01T00:00:20Z");
    expect(channel).toEqual([
      expect.objectContaining({
        cause: "channel_message",
        delivery: "turn_start",
        originServer: "plugin:agent-chat:agent-chat",
        fromName: "peer-1",
        msgId: "m1",
        blockIndex: 0,
      }),
    ]);
  });

  it("a queued_command attachment emits inbound mid_loop", async () => {
    const { inbound, queueOps } = await extractTranscript(transcript);
    const queued = inbound.filter((i) => i.ts === "2026-07-01T00:00:22Z");
    expect(queued).toEqual([expect.objectContaining({ cause: "channel_message", delivery: "mid_loop", originServer: "plugin:demo:demo", fromName: "peer-1" })]);
    const enqueue = queueOps.find((q) => q.operation === "enqueue");
    expect(queued[0]?.contentHash).toBe(enqueue?.contentHash);
  });

  it("an attachment that is not a queued_command emits no inbound", async () => {
    const { inbound } = await extractTranscript(transcript);
    expect(inbound.filter((i) => i.ts === "2026-07-01T00:00:14Z" || i.ts === "2026-07-01T00:00:23Z")).toEqual([]);
  });

  it("a tool result line emits one inbound and one context_block per tool_result block with tool_use_id", async () => {
    const { inbound, contextBlocks } = await extractTranscript(transcript);
    const at = (row: { ts: string }) => row.ts === "2026-07-01T00:00:25Z";
    expect(inbound.filter(at)).toEqual([expect.objectContaining({ cause: "tool_result", delivery: "tool_result", toolUseId: "t10" })]);
    expect(contextBlocks.filter(at).map((b) => [b.source, b.toolUseId, b.blockIndex, b.chars])).toEqual([
      ["tool_result", "t10", 0, "written".length],
      ["tool_result", "t11", 1, "https://github.com/acme/demo/pull/43".length],
    ]);
  });

  it("chunked equals whole-file for inbound, context_block and signal", async () => {
    const split = offsetAfterLine(AUDIT_FIXTURE_LINES, AUDIT_FIXTURE_LINES.length - 4);
    const full = await extractTranscript(transcript);
    const first = await extractTranscript(transcript, { untilByteOffset: split });
    const second = await extractTranscript(transcript, { fromByteOffset: first.lastByteOffset, priorPrefixHash: first.prefixHash });
    for (const kind of ["inbound", "contextBlocks", "signals"] as const) {
      expect(first[kind].length, kind).toBeGreaterThan(0);
      expect(second[kind].length, kind).toBeGreaterThan(0);
      expect([...first[kind], ...second[kind]], kind).toEqual(full[kind]);
    }
  });
});
