import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlockedFlowReport } from "@titan-design/session-analytics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { seedEventsDb } from "./fixture.js";

const DENIED = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]. Continue.";

function transcript(): string {
  const call = { timestamp: "2026-09-12T10:00:00Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr merge 3" } }] } };
  const denied = { timestamp: "2026-09-12T10:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: DENIED }] } };
  return [call, denied].map((e) => JSON.stringify(e)).join("\n");
}

let dir: string;
let transcripts: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-blocked-forks-"));
  transcripts = path.join(dir, "transcripts");
  mkdirSync(transcripts);
  writeFileSync(path.join(transcripts, "original.jsonl"), transcript());
  writeFileSync(path.join(transcripts, "resumed.jsonl"), transcript());
  writeFileSync(path.join(dir, "pulls.json"), "[]");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("insights blocked-flow over a forked transcript directory", () => {
  it("counts a refusal the resumed file repeats once", async () => {
    let stdout = "";
    const env = { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) };
    const io = { stdout: (t: string) => void (stdout += t), stderr: () => undefined, env };
    const args = ["--json", "insights", "blocked-flow", "--pulls", path.join(dir, "pulls.json"), "--transcript", `seat-a=${transcripts}`];

    const code = await runCli(["--state", path.join(dir, "state"), "--corpus", path.join(dir, "corpus"), ...args], io);

    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { data: { answer: BlockedFlowReport } }).data.answer.denials).toMatchObject({ total: 1, rows: [{ action: "merge", count: 1 }] });
  });
});
