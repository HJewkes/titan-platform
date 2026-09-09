import { describe, expect, it } from "vitest";
import { classifyOutcome, renderDiary, type ErrorSignature, type SessionDiary } from "./diary.js";

const pr = (state: string | null, mergedAt: string | null = null) => ({ ref: "pr:acme/demo#1", state, mergedAt, title: "t" });
const task = (status: string | null) => ({ ref: "task:TP-1", status, title: "t" });
const err = (count: number): ErrorSignature => ({ templateId: "tpl", partition: "Bash", signature: "TypeError <*>", count, byteOffset: 10 });

describe("classifyOutcome", () => {
  it("calls a merged pull request with no errors a success", () => {
    expect(classifyOutcome([pr("MERGED", "2026-09-01T00:00:00Z")], [], [])).toMatchObject({ status: "success", prsMerged: 1 });
  });

  it("treats a merged_at timestamp as merged even when the state is missing", () => {
    expect(classifyOutcome([pr(null, "2026-09-01T00:00:00Z")], [], []).prsMerged).toBe(1);
  });

  it("calls a done task with no errors a success", () => {
    expect(classifyOutcome([], [task("done")], [])).toMatchObject({ status: "success", tasksDone: 1 });
  });

  it("calls shipping through errors mixed, not success", () => {
    expect(classifyOutcome([pr("MERGED", "x")], [], [err(3)])).toMatchObject({ status: "mixed", errorCount: 3, distinctErrors: 1 });
  });

  it("calls a closed unmerged pull request a failure", () => {
    expect(classifyOutcome([pr("CLOSED")], [], [])).toMatchObject({ status: "failure", prsAbandoned: 1 });
  });

  it("calls errors with nothing shipped a failure", () => {
    expect(classifyOutcome([], [task("open")], [err(2), err(1)])).toMatchObject({ status: "failure", errorCount: 3, distinctErrors: 2, tasksOpen: 1 });
  });

  it("calls a quiet session with nothing shipped and nothing broken mixed", () => {
    expect(classifyOutcome([], [], []).status).toBe("mixed");
  });
});

describe("renderDiary", () => {
  const diary: SessionDiary = {
    sessionRef: "session:s1",
    title: "Fix the flaky suite",
    startedAt: "2026-09-01T00:00:00Z",
    branch: "main",
    turnCount: 4,
    commitCount: 1,
    filesTouched: ["file:demo/src/a.ts"],
    tasks: [task("done")],
    prs: [pr("MERGED", "2026-09-01T01:00:00Z")],
    subagents: 0,
    errors: [err(2)],
    outcome: classifyOutcome([pr("MERGED", "x")], [task("done")], [err(2)]),
    byteOffset: 0,
  };

  it("renders the header, the outcome line, and every non-empty section", () => {
    const text = renderDiary(diary);
    expect(text).toContain("# Session session:s1");
    expect(text).toContain("Outcome: mixed (merged 1, abandoned 0, tasks done 1, errors 2)");
    expect(text).toContain("## Recurring errors\n- (2x, Bash) TypeError <*>");
    expect(text).toContain("- task:TP-1 [done] t");
  });

  it("omits sections with nothing in them", () => {
    const text = renderDiary({ ...diary, tasks: [], prs: [], errors: [], filesTouched: [] });
    expect(text).not.toContain("## Tasks");
    expect(text).not.toContain("## Recurring errors");
  });

  it("is deterministic for the same diary", () => {
    expect(renderDiary(diary)).toBe(renderDiary(diary));
  });
});
