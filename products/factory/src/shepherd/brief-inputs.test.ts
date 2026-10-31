import { partialFake } from "@titan-design/test-kit";
import type { CheckRun } from "@titan-design/github";
import { successRun } from "@titan-design/github";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { ciState, latestVerdict } from "./brief-inputs.js";
import { summaryOf } from "./brief-render.js";

const BRIEF = { what: "w", why: "y", pros: ["p"], cons: ["c"], doorType: "two-way" } as const;

function runWith(steps: Record<string, { at: string; result: unknown }>): WorkflowRun {
  const stepResults = Object.fromEntries(Object.entries(steps).map(([stepId, { at, result }]) => [stepId, { stepId, iteration: 0, agentId: null, signal: null, completedAt: at, data: { result } }]));
  return partialFake<WorkflowRun>({ stepResults });
}

const verdict = (head: string, kind: "MERGE" | "FIX_FIRST", ownerBrief?: unknown) => ({ kind: "verdict", verdict: kind, head, reviewer: { agentId: "rv" }, ...(ownerBrief !== undefined && { ownerBrief }) });

describe("latestVerdict", () => {
  it("takes the newest verdict step and carries its owner brief", () => {
    const run = runWith({ "sh-await-verdict:aaa": { at: "2026-01-01T00:00:00Z", result: verdict("aaa", "FIX_FIRST") }, "sh-await-verdict:bbb": { at: "2026-01-02T00:00:00Z", result: verdict("bbb", "MERGE", BRIEF) } });

    expect(latestVerdict(run)).toEqual({ verdict: "MERGE", head: "bbb", reviewer: "rv", ownerBrief: BRIEF });
  });

  it("skips a wait that ended with no verdict", () => {
    const run = runWith({ "sh-await-verdict:aaa": { at: "2026-01-01T00:00:00Z", result: verdict("aaa", "MERGE") }, "sh-await-verdict:bbb": { at: "2026-01-02T00:00:00Z", result: { kind: "none" } } });

    expect(latestVerdict(run)).toMatchObject({ head: "aaa" });
  });

  it("reads no verdict from a run with none", () => {
    expect(latestVerdict(runWith({}))).toBeUndefined();
  });
});

describe("ciState", () => {
  const running: CheckRun = { ...successRun("validate", 3), status: "in_progress", conclusion: null };

  it("is green only when every check completed without failing", () => {
    expect(ciState([successRun("a", 1), successRun("b", 2)])).toBe("green");
    expect(ciState([successRun("a", 1), running])).toBe("pending");
    expect(ciState([])).toBe("pending");
  });

  it("is red when any check failed, even beside a running one", () => {
    expect(ciState([successRun("a", 1, undefined, "failure"), running])).toBe("red");
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
