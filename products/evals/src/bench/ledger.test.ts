import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJsonl, JOB_SCHEMA, nextAttempt, readJobRows, type JobRow, type Outcome } from "./ledger.js";

const row = (armId: string, caseHash: string, outcome: Outcome, attempt = 1): JobRow => ({
  schema: JOB_SCHEMA,
  track: "r",
  arm: { id: armId, model: "claude-haiku-5-5", effort: "high" },
  caseId: `case-${caseHash}`,
  caseHash,
  block: 0,
  stratum: null,
  attempt,
  sessionId: `session-${armId}-${caseHash}-${attempt}`,
  transcript: "",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
  seconds: 60,
  exit: { code: 0, timedOut: false },
  outcome,
  tokens: null,
  listUsd: null,
  effortSeen: null,
  modelSeen: null,
});

describe("resuming from jobs.jsonl", () => {
  let dir: string;
  let ledger: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-ledger-"));
    ledger = join(dir, "jobs.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("skips keys whose last row is terminal and runs unseen keys as attempt 1", () => {
    for (const outcome of ["ok", "timeout", "error", "contaminated"] as const) appendJsonl(ledger, row(`A-${outcome}`, "h1", outcome));
    const rows = readJobRows(ledger);

    for (const outcome of ["ok", "timeout", "error", "contaminated"]) expect(nextAttempt(rows, `A-${outcome}`, "h1")).toBeNull();
    expect(nextAttempt(rows, "A-ok", "h2")).toBe(1);
  });

  it("re-runs an infra key once, then leaves a second infra as it is", () => {
    appendJsonl(ledger, row("H-high", "h1", "infra"));
    expect(nextAttempt(readJobRows(ledger), "H-high", "h1")).toBe(2);

    appendJsonl(ledger, row("H-high", "h1", "infra", 2));
    expect(nextAttempt(readJobRows(ledger), "H-high", "h1")).toBeNull();
  });

  it("keys on arm and case together", () => {
    appendJsonl(ledger, row("O-med", "h1", "ok"));
    const rows = readJobRows(ledger);

    expect(nextAttempt(rows, "S-med", "h1")).toBe(1);
    expect(nextAttempt(rows, "O-med", "h9")).toBe(1);
  });

  it("drops a torn final line from a crash but refuses a corrupt middle line", () => {
    appendJsonl(ledger, row("O-med", "h1", "ok"));
    appendFileSync(ledger, '{"schema":"titan.bench-job/v1","arm":');
    expect(readJobRows(ledger)).toHaveLength(1);

    appendFileSync(ledger, "\n");
    appendJsonl(ledger, row("O-med", "h2", "ok"));
    expect(() => readJobRows(ledger)).toThrow(/jobs.jsonl:2 is not JSON/);
  });

  it("appends one newline-terminated row per call", () => {
    appendJsonl(ledger, row("O-med", "h1", "ok"));
    appendJsonl(ledger, row("O-med", "h2", "ok"));

    expect(readFileSync(ledger, "utf8").split("\n")).toHaveLength(3);
  });
});
