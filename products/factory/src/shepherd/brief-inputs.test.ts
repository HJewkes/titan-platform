import { partialFake } from "@titan-design/test-kit";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { verdictForHead } from "./brief-inputs.js";
import { summaryOf } from "./brief-render.js";

const BRIEF = { what: "w", why: "y", pros: ["p"], cons: ["c"], doorType: "two-way" } as const;

function runWith(steps: Record<string, { at: string; result: unknown }>): WorkflowRun {
  const stepResults = Object.fromEntries(Object.entries(steps).map(([stepId, { at, result }]) => [stepId, { stepId, iteration: 0, agentId: null, signal: null, completedAt: at, data: { result } }]));
  return partialFake<WorkflowRun>({ stepResults });
}

const verdict = (head: string, kind: "MERGE" | "FIX_FIRST", ownerBrief?: unknown) => ({ kind: "verdict", verdict: kind, head, reviewer: { agentId: "rv" }, ...(ownerBrief !== undefined && { ownerBrief }) });

describe("verdictForHead", () => {
  it("falls back to the newest verdict at an older head and carries its owner brief", () => {
    const run = runWith({ "sh-await-verdict:aaa": { at: "2026-01-01T00:00:00Z", result: verdict("aaa", "FIX_FIRST") }, "sh-await-verdict:bbb": { at: "2026-01-02T00:00:00Z", result: verdict("bbb", "MERGE", BRIEF) } });

    expect(verdictForHead(run, "ccc")).toEqual({ verdict: "MERGE", head: "bbb", reviewer: "rv", ownerBrief: BRIEF });
  });

  it("skips a wait that ended with no verdict", () => {
    const run = runWith({ "sh-await-verdict:aaa": { at: "2026-01-01T00:00:00Z", result: verdict("aaa", "MERGE") }, "sh-await-verdict:bbb": { at: "2026-01-02T00:00:00Z", result: { kind: "none" } } });

    expect(verdictForHead(run, "ccc")).toMatchObject({ head: "aaa" });
  });

  it("reads no verdict from a run with none", () => {
    expect(verdictForHead(runWith({}), "aaa")).toBeUndefined();
  });

  it("reports a panel member's FIX_FIRST at the head even when a later member gave MERGE there", () => {
    const run = runWith({
      "sh-await-verdict:hhh": { at: "2026-01-01T00:00:00Z", result: verdict("hhh", "MERGE", BRIEF) },
      "sh-await-verdict:hhh:correctness": { at: "2026-01-02T00:00:00Z", result: { ...verdict("hhh", "FIX_FIRST", BRIEF), reviewer: { agentId: "rv-correctness" } } },
      "sh-await-verdict:hhh:adversary": { at: "2026-01-03T00:00:00Z", result: verdict("hhh", "MERGE", BRIEF) },
    });

    expect(verdictForHead(run, "hhh")).toMatchObject({ verdict: "FIX_FIRST", head: "hhh", reviewer: "rv-correctness" });
  });

  it("does not report a newer MERGE at the head as reviewed when the head's own step is missing", () => {
    const run = runWith({ "sh-await-verdict:ggg": { at: "2026-01-01T00:00:00Z", result: verdict("ggg", "MERGE") }, "sh-await-verdict:hhh:adversary": { at: "2026-01-02T00:00:00Z", result: verdict("hhh", "MERGE") } });

    expect(verdictForHead(run, "hhh")).toMatchObject({ verdict: "MERGE", head: "ggg" });
  });

  it("reports MERGE at the head when every record there agrees", () => {
    const run = runWith({ "sh-await-verdict:hhh": { at: "2026-01-01T00:00:00Z", result: verdict("hhh", "MERGE", BRIEF) }, "sh-await-verdict:hhh:adversary": { at: "2026-01-02T00:00:00Z", result: verdict("hhh", "MERGE") } });

    expect(verdictForHead(run, "hhh")).toEqual({ verdict: "MERGE", head: "hhh", reviewer: "rv", ownerBrief: BRIEF });
  });
});

describe("summaryOf", () => {
  it("returns the Summary section up to the next heading", () => {
    expect(summaryOf("intro\n## Summary\nOne.\nTwo.\n\n## Test plan\nRan.")).toBe("One.\nTwo.");
  });

  it("is undefined when the body has no Summary section", () => {
    expect(summaryOf("## Notes\nText")).toBeUndefined();
  });
});
