import { describe, expect, it, vi } from "vitest";
import { claudeJudge, JudgeUnavailable, judgeOrUnavailable, type AuditJudge, type JudgeInput } from "./audit-judge.js";

const usage = { totalCostUsd: 0.01, modelUsage: {}, turns: 1, durationMs: 900 };
const init = { apiKeySource: undefined, model: "sonnet", tools: [], permissionMode: undefined, claudeCodeVersion: undefined };

const input: JudgeInput = {
  gateId: "run-1/approve-merge:0",
  class: "D1",
  question: "Merge PR #12?",
  answer: "merge",
  waitHours: 0.1,
  evidence: undefined,
  facts: { decision: "merge", merged: true, reverted: false, mainRed: false, incidents: [], windowClosed: true },
};

describe("judgeOrUnavailable", () => {
  it("passes a valid note through", async () => {
    const judge: AuditJudge = async () => ({ stamp: "stamp", note: "approved in six minutes with no evidence read" });

    expect(await judgeOrUnavailable(judge, input)).toEqual({ stamp: "stamp", note: "approved in six minutes with no evidence read" });
  });

  it("names the agent failure kind when the call fails", async () => {
    const judge: AuditJudge = () => Promise.reject(new JudgeUnavailable("auth_misconfigured", "not logged in"));

    expect(await judgeOrUnavailable(judge, input)).toEqual({ unavailable: "auth_misconfigured" });
  });

  it("reads a note that breaks the schema as schema_invalid, and any other throw as error", async () => {
    const tooLong: AuditJudge = async () => ({ stamp: "stamp", note: "x".repeat(281) });
    const broken: AuditJudge = () => Promise.reject(new Error("boom"));

    expect(await judgeOrUnavailable(tooLong, input)).toEqual({ unavailable: "schema_invalid" });
    expect(await judgeOrUnavailable(broken, input)).toEqual({ unavailable: "error" });
  });

  it("says the judge was disabled when none is given", async () => {
    expect(await judgeOrUnavailable(undefined, input)).toEqual({ unavailable: "disabled" });
  });
});

describe("claudeJudge", () => {
  it("asks sonnet for one turn through claude -p and returns its note", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, output: { stamp: "did-work", note: "read the diff" }, sessionId: "s1", usage, init });

    const note = await claudeJudge("/tmp", run)(input);

    expect(note).toEqual({ stamp: "did-work", note: "read the diff" });
    expect(run.mock.calls[0]![0]).toMatchObject({ harness: "claude-print", model: "sonnet", maxTurns: 1, cwd: "/tmp" });
  });

  it("throws the agent's failure kind, which the report names as unavailable", async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, failure: { kind: "rate_limited", reason: "quota" } });

    expect(await judgeOrUnavailable(claudeJudge("/tmp", run), input)).toEqual({ unavailable: "rate_limited" });
  });
});
