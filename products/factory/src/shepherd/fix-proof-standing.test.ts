import { fakeSha } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { readFixProofAt } from "./fix-proof.js";

/** Synthetic stand-in for tp#1356's head, whose fix-proof read errored with "HTTP 200". */
const HEAD = fakeSha("fix-proof-standing-head");
const TARGET = { repo: "octo/demo", head: HEAD };
const STEP = `sh-fix-proof:${HEAD}`;
const ERROR = { kind: "error", reason: "the fix-proof check could not be read: HTTP 200" };
const RESULT = { kind: "result", line: "FIX_PROOF_RESULT {}", verdict: "proven" };

interface Recorded {
  /** What each read at the head answers, in order. */
  reads: object[];
  /** Reads earlier rounds of this run already took at the head. */
  earlier?: number;
  /** The step a replay's record names after the first read, or undefined past the record. */
  next?: string;
}

/** A context counting iterations as the workflow does; it logs each read and answers from `reads`. */
function reading(recorded: Recorded): { ctx: WorkflowContext; dispatched: string[] } {
  const dispatched: string[] = [];
  const iterations = new Map<string, number>([[STEP, recorded.earlier ?? 0]]);
  const unused = (): never => {
    throw new Error("not used here");
  };
  const ctx: WorkflowContext = {
    runId: "run-1",
    workflowName: "shepherd-pr",
    signal: new AbortController().signal,
    param: () => undefined,
    iteration: (stepId) => iterations.get(stepId) ?? 0,
    historyNext: () => recorded.next,
    resumedGate: () => undefined,
    recoveredInFlight: () => [],
    capability: () => { throw new Error("no capabilities in this fake"); },
    expireGates: () => [],
    dispatch: async (stepId, _template, options) => {
      const iteration = iterations.get(stepId) ?? 0;
      iterations.set(stepId, iteration + 1);
      dispatched.push(stepId);
      const result = recorded.reads[dispatched.length - 1];
      return { stepId, iteration, agentId: null, signal: null, completedAt: "2026-10-13T00:00:00.000Z", data: options?.schema?.parse({ result }) };
    },
    seed: unused,
    assisted: unused,
    authorize: unused,
  };
  return { ctx, dispatched };
}

describe("the fix-proof read at a head", () => {
  it("reads a failed read once more at the same head and takes the second answer (tp#1356)", async () => {
    const { ctx, dispatched } = reading({ reads: [ERROR, RESULT] });

    const read = await readFixProofAt(ctx, TARGET);

    expect(dispatched).toEqual([STEP, STEP]);
    expect(read).toMatchObject(RESULT);
  });

  it("stops after one re-read, so a read that keeps failing stands as an error", async () => {
    const { ctx, dispatched } = reading({ reads: [ERROR, ERROR, RESULT] });

    const read = await readFixProofAt(ctx, TARGET);

    expect(dispatched).toEqual([STEP, STEP]);
    expect(read).toMatchObject(ERROR);
  });

  it.each([
    ["a result", RESULT],
    ["a missing run", { kind: "missing", reason: "no fix-proof run" }],
    ["an untrusted result", { ...RESULT, kind: "untrusted", reason: "the PR edits the harness" }],
  ])("reads %s only once", async (_name, answer) => {
    const { ctx, dispatched } = reading({ reads: [answer, RESULT] });

    await readFixProofAt(ctx, TARGET);

    expect(dispatched).toEqual([STEP]);
  });

  it("does not re-read on a later round at the same head, which reads afresh anyway", async () => {
    const { ctx, dispatched } = reading({ reads: [ERROR, RESULT], earlier: 2 });

    const read = await readFixProofAt(ctx, TARGET);

    expect(dispatched).toEqual([STEP]);
    expect(read).toMatchObject(ERROR);
  });

  it("keeps the one read of a replay recorded before the re-read existed", async () => {
    const { ctx, dispatched } = reading({ reads: [ERROR, RESULT], next: `sh-review-intent:${HEAD}` });

    await readFixProofAt(ctx, TARGET);

    expect(dispatched).toEqual([STEP]);
  });

  it("replays a recorded re-read", async () => {
    const { ctx, dispatched } = reading({ reads: [ERROR, RESULT], next: STEP });

    const read = await readFixProofAt(ctx, TARGET);

    expect(dispatched).toEqual([STEP, STEP]);
    expect(read).toMatchObject(RESULT);
  });
});
