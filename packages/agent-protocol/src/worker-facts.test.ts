import { describe, expect, it } from "vitest";
import { MAX_WORKER_REPORT_LENGTH, WorkerFactsSchema } from "./worker-facts.js";

const exit = { code: 0, signal: null, inferred: false };

const withReport = {
  agent: "tc-tp-9001-widget",
  profile: "implementer",
  spawner: "example-coord",
  taskId: "TP-9001",
  report: { messageId: "msg-0001", kind: "status", text: "Status: DONE" },
  pr: { repo: "example-org/example-repo", number: 42 },
  tokens: { input: 1200, output: 300, total: 1500 },
  costUsd: 1.25,
  exit,
};

describe("WorkerFactsSchema", () => {
  it("accepts a worker that reported a status, a PR and its cost", () => {
    expect(WorkerFactsSchema.parse(withReport)).toEqual(withReport);
  });

  it("accepts a no-report exit carrying only the exit facts", () => {
    const facts = { agent: "scratch-helper", profile: "reviewer", spawner: "example-coord", exit: { code: null, signal: "SIGKILL", inferred: true } };
    expect(WorkerFactsSchema.parse(facts)).toEqual(facts);
  });

  it("accepts a report exactly at the cap and rejects one over it", () => {
    const report = (length: number) => ({ ...withReport, report: { ...withReport.report, text: "x".repeat(length) } });
    expect(WorkerFactsSchema.safeParse(report(MAX_WORKER_REPORT_LENGTH)).success).toBe(true);
    expect(WorkerFactsSchema.safeParse(report(MAX_WORKER_REPORT_LENGTH + 1)).success).toBe(false);
  });

  it("rejects a PR given as a URL string and a repo that is not owner/name", () => {
    expect(WorkerFactsSchema.safeParse({ ...withReport, pr: "https://example.test/o/r/pull/1" }).success).toBe(false);
    expect(WorkerFactsSchema.safeParse({ ...withReport, pr: { repo: "no-owner", number: 1 } }).success).toBe(false);
  });
});
