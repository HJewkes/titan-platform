import { fakeSha } from "@titan-design/github";
import { CI_UNREAD_LINE } from "@titan-design/review-panel";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { CI_UNREAD_REASON, ciUnreadAsNone } from "./ci-unread.js";
import type { Verdict } from "./phases.js";

const HEAD = fakeSha("ci-unread-head");
const block = `Verdict: FIX_FIRST\nPR: octo/demo#1\nHead: ${HEAD}`;
const fixFirst = (findings: string): Verdict => ({ kind: "FIX_FIRST", headSha: HEAD, text: `${findings}\n\nDefect class: CI unread.\n\n${block}` });

/** A context whose recorded history names `next` as the following step; every step answers its own input. */
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
    expireGates: () => [],
    dispatch: async (stepId, _template, options) => {
      dispatched.push(stepId);
      const input: unknown = JSON.parse(Object.values(options?.vars ?? {})[0] ?? "null");
      return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "2026-10-17T00:00:00.000Z", data: options?.schema?.parse({ result: input }) };
    },
    seed: unused,
    assisted: unused,
    authorize: unused,
  };
  return { ctx, dispatched };
}

describe("ciUnreadAsNone", () => {
  it("a FIX_FIRST whose only item is the CI-unread line is no verdict, recorded as its own step", async () => {
    const { ctx, dispatched } = contextAt(undefined);

    const taken = await ciUnreadAsNone(ctx, HEAD, fixFirst(`- ${CI_UNREAD_LINE}`));

    expect(taken).toEqual({ kind: "none", cause: "no-verdict", reason: CI_UNREAD_REASON });
    expect(dispatched).toEqual([`sh-ci-unread:${HEAD}`]);
  });

  it("a FIX_FIRST with a real item and the CI-unread line stays FIX_FIRST", async () => {
    const { ctx, dispatched } = contextAt(undefined);
    const verdict = fixFirst(`- ${CI_UNREAD_LINE}\n- The retry never stops.`);

    expect(await ciUnreadAsNone(ctx, HEAD, verdict)).toBe(verdict);
    expect(dispatched).toEqual([]);
  });

  it("a run recorded before the step replays its CI-unread FIX_FIRST as the FIX_FIRST it took", async () => {
    const { ctx, dispatched } = contextAt(`sh-observe:${HEAD}`);
    const verdict = fixFirst(`- ${CI_UNREAD_LINE}`);

    expect(await ciUnreadAsNone(ctx, HEAD, verdict)).toBe(verdict);
    expect(dispatched).toEqual([]);
  });

  it.each([`sh-ci-unread:${HEAD}`, `sh-ci-unread:${HEAD}:1`])("a run recorded with the step (%s) replays it as no verdict", async (next) => {
    const { ctx, dispatched } = contextAt(next);

    expect(await ciUnreadAsNone(ctx, HEAD, fixFirst(CI_UNREAD_LINE))).toMatchObject({ kind: "none", cause: "no-verdict" });
    expect(dispatched).toEqual([`sh-ci-unread:${HEAD}`]);
  });

  it("a MERGE passes through untouched", async () => {
    const { ctx, dispatched } = contextAt(undefined);
    const merge: Verdict = { kind: "MERGE", headSha: HEAD, evidence: {} };

    expect(await ciUnreadAsNone(ctx, HEAD, merge)).toBe(merge);
    expect(dispatched).toEqual([]);
  });
});
