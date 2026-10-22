import { fakeSha } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import { standingMerge } from "./merge-standing.js";
import type { Verdict } from "./phases.js";

const HEAD = fakeSha("standing-head");
const RV = { agentId: "agent-rv", sessionId: "session-rv" };

/** An evidence step's output at HEAD, whole as the step writes it. */
const wholeEvidence = {
  head: HEAD,
  merge: { head: HEAD, resolver: RV, dispatchedReviewer: RV, verdict: { value: "MERGE", head: HEAD }, requiredContexts: [], allowedApps: [], checkRuns: [], mergeTreeClean: true, repoFrozen: false, changedPaths: ["src/a.ts"], seatGrants: [] },
  record: { runId: "run-1", repo: "octo/demo", pr: 1, head: HEAD, baseRef: "main", testMergeSha: null, checkRuns: [], verdictLocator: {}, reviewer: RV, decision: { outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV", version: 1 }, reason: "test" } },
};

/** A context whose recorded history names `next` as the following step; its evidence step answers `wholeEvidence`, and every other step its own input. */
function contextAt(next: string | undefined): { ctx: WorkflowContext; dispatched: string[] } {
  const dispatched: string[] = [];
  const unused = (): never => {
    throw new Error("not used here");
  };
  const ctx: WorkflowContext = {
    runId: "run-1",
    workflowName: "shepherd-pr",
    signal: new AbortController().signal,
    param: () => undefined,
    iteration: () => 0,
    historyNext: () => next,
    resumedGate: () => undefined,
    recoveredInFlight: () => [],
    capability: () => { throw new Error("no capabilities in this fake"); },
    expireGates: () => [],
    dispatch: async (stepId, _template, options) => {
      dispatched.push(stepId);
      const input: unknown = JSON.parse(Object.values(options?.vars ?? {})[0] ?? "null");
      return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "2026-10-12T00:00:00.000Z", data: options?.schema?.parse({ result: stepId.startsWith("sh-merge-evidence:") ? wholeEvidence : input }) };
    },
    seed: unused,
    assisted: unused,
    authorize: unused,
  };
  return { ctx, dispatched };
}

const merge = (evidence: unknown): Verdict => ({ kind: "MERGE", headSha: HEAD, evidence });

describe("standingMerge", () => {
  it("records the refusal, then reads the evidence again, and keeps the MERGE with the new evidence", async () => {
    const { ctx, dispatched } = contextAt(undefined);

    const kept = await standingMerge(ctx, merge(wholeEvidence), HEAD, () => ({ cause: "owner-request" }));

    expect(dispatched).toEqual([`sh-review-refused:${HEAD}`, `sh-merge-evidence:${HEAD}`]);
    expect(kept).toEqual({ kind: "MERGE", headSha: HEAD, evidence: wholeEvidence });
  });

  it("keeps a recorded run's second reviewer on replay, taking no step and spending no cause", async () => {
    const { ctx, dispatched } = contextAt(`sh-review-intent:${HEAD}:1`);
    const causeOf = vi.fn(() => ({ cause: "owner-request" as const }));

    expect(await standingMerge(ctx, merge(wholeEvidence), HEAD, causeOf)).toBeUndefined();
    expect(dispatched).toEqual([]);
    expect(causeOf).not.toHaveBeenCalled();
  });

  it.each([
    ["evidence that is not whole", merge({ head: HEAD, merge: {}, record: {} })],
    ["evidence about another head", merge({ ...wholeEvidence, head: fakeSha("other") })],
    ["a MERGE carried from another head", merge({ ...wholeEvidence, merge: { ...wholeEvidence.merge, verdict: { value: "MERGE", head: fakeSha("reviewed") } } })],
    ["a MERGE whose evidence records a carry", merge({ ...wholeEvidence, merge: { ...wholeEvidence.merge, carry: { fromHead: fakeSha("reviewed"), head: HEAD, headTree: "t", mergeTree: "t" } } })],
    ["a FIX_FIRST", { kind: "FIX_FIRST", headSha: HEAD, text: "fix it" } satisfies Verdict],
  ])("reviews as before for %s", async (_name, verdict) => {
    const { ctx, dispatched } = contextAt(undefined);

    expect(await standingMerge(ctx, verdict, HEAD, () => ({ cause: "unknown" }))).toBeUndefined();
    expect(dispatched).toEqual([]);
  });
});
