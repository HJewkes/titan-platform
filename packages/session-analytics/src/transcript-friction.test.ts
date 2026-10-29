import { describe, expect, it } from "vitest";
import { followUpSignals, transcriptSignals, type LogSignal } from "./transcript-friction.js";

const WINDOW = { since: "2030-01-01T00:00:00.000Z", until: "2030-01-02T00:00:00.000Z" };
const at = (minute: number) => new Date(Date.parse(WINDOW.since) + 3_600_000 + minute * 60_000).toISOString();

let ids = 0;
/** A Bash or other tool call, and its result `took` minutes later; returns both transcript lines. */
function call(minute: number, name: string, input: object, result: string, options: { took?: number; isError?: boolean } = {}): string[] {
  const id = `c${(ids += 1)}`;
  const use = { type: "assistant", timestamp: at(minute), message: { content: [{ type: "tool_use", id, name, input }] } };
  const done = { type: "user", timestamp: at(minute + (options.took ?? 0.1)), message: { content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: options.isError ?? false }] } };
  return [JSON.stringify(use), JSON.stringify(done)];
}
const bash = (minute: number, command: string, result = "ok", options: { took?: number; isError?: boolean } = {}) => call(minute, "Bash", { command }, result, options);
const prompt = (minute: number) => JSON.stringify({ type: "user", timestamp: at(minute), message: { content: "next round, please" } });
const summary = (signals: LogSignal[]) => signals.map((s) => [s.kind, s.cluster, Math.round(s.hours * 60)]);

describe("friction in a worker's transcript", () => {
  it("classes a classifier denial with Q5's classes and charges the time to the next move", () => {
    const lines = [
      ...bash(0, "gh pr merge 1", "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Merge Without Review]", { isError: true }),
      ...bash(3, "git status"),
    ];

    expect(summary(transcriptSignals(lines, WINDOW))).toEqual([["denial", "denials", 3]]);
  });

  it("maps tool errors to buckets and leaves an unnamed one in other", () => {
    const lines = [
      ...call(0, "Edit", { file_path: "a.ts" }, "File has not been read yet. Read it first before writing to it.", { isError: true }),
      ...bash(1, "false", "Exit code 1", { isError: true }),
      ...bash(2, "gh pr view 1", "GraphQL: API rate limit exceeded", { isError: true }),
    ];

    expect(transcriptSignals(lines, WINDOW).map((s) => [s.detail, s.cluster])).toEqual([
      ["edit-not-read", "missing-context"],
      ["exit-code", "other"],
      ["gh-graphql-ratelimit", "broker-infra"],
    ]);
  });

  it("counts a long check run and a long CI poll as ci-wait", () => {
    const lines = [...bash(0, "pnpm vitest run packages/a", "ok", { took: 12 }), ...bash(13, "gh pr checks 7 --watch", "ok", { took: 8 })];

    expect(summary(transcriptSignals(lines, WINDOW))).toEqual([
      ["wait", "ci-wait", 12],
      ["wait", "ci-wait", 8],
    ]);
  });

  it("counts an idle gap inside a turn, but not one that ends at a new prompt", () => {
    const lines = [...bash(0, "ls"), ...bash(10, "ls -a"), prompt(100), ...bash(101, "git log")];

    expect(summary(transcriptSignals(lines, WINDOW))).toEqual([["wait", "other", 10]]);
  });

  it("flags a test re-run with no edit in between as flaky-test, and not one after an edit", () => {
    const lines = [
      ...bash(0, "pnpm test"),
      ...bash(1, "pnpm test"),
      ...call(2, "Edit", { file_path: "a.ts" }, "ok"),
      ...bash(3, "pnpm test"),
    ];

    expect(summary(transcriptSignals(lines, WINDOW))).toEqual([["test-rerun", "flaky-test", 0]]);
  });

  it("puts a repeated failing command in its error's bucket", () => {
    const lines = [...bash(0, "gh pr view 3", "HTTP 502", { isError: true }), ...bash(1, "gh pr view 3")];

    expect(transcriptSignals(lines, WINDOW).map((s) => [s.kind, s.cluster])).toEqual([
      ["tool-error", "broker-infra"],
      ["retry", "broker-infra"],
    ]);
  });

  it("ignores lines outside the window", () => {
    const early = { ...WINDOW, since: at(5) };

    expect(transcriptSignals(bash(0, "x", "Exit code 1", { isError: true }), early)).toEqual([]);
  });
});

describe("a spawner's follow-ups", () => {
  it("turns a brief fix or a correction into missing-context, and ignores a status poll", () => {
    const signals = followUpSignals([
      { at: at(0), body: "Correction to your brief: the package is store-sqlite" },
      { at: at(1), body: "Any update?" },
    ]);

    expect(signals.map((s) => [s.kind, s.cluster, s.detail])).toEqual([["follow-up", "missing-context", "brief-fix"]]);
  });
});
