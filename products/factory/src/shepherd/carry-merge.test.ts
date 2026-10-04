import { fakeSha } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { carriedSource, carriedVerdict, carrySeatRoute } from "./carry-merge.js";
import type { ReviewerAgent, ReviewerMessage, ReviewWiring } from "./review.js";
import type { RoutedStepInput } from "@titan-design/workflow";
import type { Verdict } from "./phases.js";
import type { CarryResult } from "./tree-carry.js";

const REPO = "acme/widgets";
const TARGET = { repo: REPO, pr: 1 };
const REVIEWED = fakeSha("reviewed");
const NEW_HEAD = fakeSha("new-head");
const AGENT = { agentId: "rv-1", sessionId: "s-1" };
const EQUAL: CarryResult = { equal: true, base: fakeSha("main"), headTree: "tree-a", mergeTree: "tree-a" };

function mergeAt(head: string, verdictHead = head, extra: object = {}): Verdict {
  const merge = { head, verdict: { value: "MERGE", head: verdictHead }, resolver: AGENT, dispatchedReviewer: AGENT, seatGrants: ["merge-on-green-approve"] };
  return { kind: "MERGE", headSha: head, evidence: { head, merge, record: { verdictLocator: { sourceId: "synthetic" } }, ...extra } };
}

interface Rig {
  ctx: WorkflowContext;
  asked: { stepId: string; input: Record<string, unknown> }[];
}

/** A context whose steps answer from the given scope and probe result, recording each step's input. */
function rig(scope: { kind: string | null; baseRef: string | null }, probe: CarryResult, seats: { clear: boolean } = { clear: true }): Rig {
  const asked: Rig["asked"] = [];
  const answer = (stepId: string, input: Record<string, unknown>): object => {
    if (stepId.startsWith("sh-carry-scope")) return scope;
    if (stepId.startsWith("sh-carry:")) return probe;
    if (stepId.startsWith("sh-carry-seat:")) return seats;
    return { head: input.head, merge: {}, record: {} };
  };
  const dispatch = async (stepId: string, _template: string, options: { vars: Record<string, string> }) => {
    const input = JSON.parse(Object.values(options.vars)[0]!) as Record<string, unknown>;
    asked.push({ stepId, input });
    return { data: { result: answer(stepId, input) } };
  };
  return { ctx: { runId: "run-1", dispatch } as unknown as WorkflowContext, asked };
}

const reviews = (...entries: [string, Verdict][]): Map<string, Verdict> => new Map(entries);
const carryOf = (r: Rig) => r.asked.find((step) => step.stepId.startsWith("sh-merge-evidence"))?.input.carry;
const carried = (r: Rig, map: Map<string, Verdict>) => carriedVerdict(r.ctx, TARGET, map, NEW_HEAD, 0);

describe("carrying a MERGE to a tree-equal head", () => {
  it("takes the MERGE through the evidence step with the probe's fact and the reviewed head as verdict head", async () => {
    const r = rig({ kind: "correctness", baseRef: "main" }, EQUAL);

    const verdict = await carried(r, reviews([REVIEWED, mergeAt(REVIEWED)]));

    expect(verdict).toMatchObject({ kind: "MERGE", headSha: NEW_HEAD });
    const evidence = r.asked.find((step) => step.stepId.startsWith("sh-merge-evidence"))!.input;
    expect(evidence).toMatchObject({ head: NEW_HEAD, verdict: { value: "MERGE", head: REVIEWED }, resolver: AGENT, dispatchedReviewer: AGENT });
    expect(evidence.carry).toEqual({ fromHead: REVIEWED, head: NEW_HEAD, result: EQUAL });
    expect(r.asked.find((step) => step.stepId.startsWith("sh-carry:"))!.input).toEqual({ repo: REPO, baseRef: "main", fromHead: REVIEWED, head: NEW_HEAD });
  });

  it("records the seat check as a step over the reviewed head, every head the run saw, and the new head", async () => {
    const r = rig({ kind: "correctness", baseRef: "main" }, EQUAL);
    const middle = fakeSha("middle");

    await carried(r, reviews([REVIEWED, mergeAt(REVIEWED)], [middle, mergeAt(middle, REVIEWED)]));

    const ids = r.asked.map((step) => step.stepId);
    expect(ids.indexOf(`sh-carry-seat:${NEW_HEAD}`)).toBeGreaterThan(ids.indexOf(`sh-carry:${NEW_HEAD}`));
    expect(ids.indexOf(`sh-carry-seat:${NEW_HEAD}`)).toBeLessThan(ids.findIndex((id) => id.startsWith("sh-merge-evidence")));
    expect(r.asked.find((step) => step.stepId.startsWith("sh-carry-seat"))!.input.heads).toEqual([REVIEWED, middle, NEW_HEAD]);
  });

  it("does not carry when a seat reviewer said FIX_FIRST at one of those heads, and takes no evidence", async () => {
    const r = rig({ kind: "correctness", baseRef: "main" }, EQUAL, { clear: false });

    await expect(carried(r, reviews([REVIEWED, mergeAt(REVIEWED)]))).resolves.toBeUndefined();

    expect(r.asked.some((step) => step.stepId.startsWith("sh-merge-evidence"))).toBe(false);
  });

  it("carries a carried MERGE on from the head it was first reviewed at", async () => {
    const r = rig({ kind: "feature", baseRef: "main" }, EQUAL);
    const second = fakeSha("second");

    await carried(r, reviews([REVIEWED, mergeAt(REVIEWED)], [second, mergeAt(second, REVIEWED)]));

    expect(r.asked.find((step) => step.stepId.startsWith("sh-carry:"))!.input).toMatchObject({ fromHead: REVIEWED });
    expect(carryOf(r)).toMatchObject({ fromHead: REVIEWED, head: NEW_HEAD });
  });

  it("takes the fact from the probe, never from a carry the earlier evidence names", async () => {
    const r = rig({ kind: "correctness", baseRef: "main" }, EQUAL);
    const forged = { fromHead: REVIEWED, head: NEW_HEAD, headTree: "forged", mergeTree: "forged" };

    await carried(r, reviews([REVIEWED, mergeAt(REVIEWED, REVIEWED, { carry: forged })]));

    expect(carryOf(r)).toEqual({ fromHead: REVIEWED, head: NEW_HEAD, result: EQUAL });
  });

  it.each([["security"], ["unknown"], [null]])("does not carry for kind %s and does not probe", async (kind) => {
    const r = rig({ kind, baseRef: "main" }, EQUAL);

    await expect(carried(r, reviews([REVIEWED, mergeAt(REVIEWED)]))).resolves.toBeUndefined();

    expect(r.asked.map((step) => step.stepId)).toEqual(["sh-carry-scope:0"]);
  });

  it("does not carry from a FIX_FIRST head even when an older head has a MERGE", async () => {
    const r = rig({ kind: "correctness", baseRef: "main" }, EQUAL);
    const fix = fakeSha("fix");

    const verdict = await carried(r, reviews([REVIEWED, mergeAt(REVIEWED)], [fix, { kind: "FIX_FIRST", headSha: fix, text: "x" }]));

    expect(verdict).toBeUndefined();
    expect(r.asked).toEqual([]);
  });

  it.each([["none", { kind: "none" } as Verdict], ["NO_REPRO", { kind: "NO_REPRO", headSha: REVIEWED, result: {} } as Verdict]])("does not carry from a %s verdict", async (_name, latest) => {
    const r = rig({ kind: "correctness", baseRef: "main" }, EQUAL);

    await expect(carried(r, reviews([fakeSha("old"), mergeAt(fakeSha("old"))], [REVIEWED, latest]))).resolves.toBeUndefined();

    expect(r.asked).toEqual([]);
  });

  it.each([
    ["unequal trees", { equal: true, headTree: "a", mergeTree: "b" }],
    ["a missing tree", { equal: true, mergeTree: "a" }],
    ["an answer of not equal", { equal: false, headTree: "a", mergeTree: "a", reason: "differs" }],
  ])("does not carry on %s", async (_name, probe) => {
    const r = rig({ kind: "correctness", baseRef: "main" }, probe);

    await expect(carried(r, reviews([REVIEWED, mergeAt(REVIEWED)]))).resolves.toBeUndefined();

    expect(carryOf(r)).toBeUndefined();
  });

  it("does not carry from evidence whose verdict head is not a full sha", () => {
    expect(carriedSource(reviews([REVIEWED, mergeAt(REVIEWED, REVIEWED.slice(0, 12))]), NEW_HEAD)).toBeUndefined();
  });

  it("does not carry from evidence collected at another head than the verdict's", () => {
    expect(carriedSource(reviews([REVIEWED, { ...mergeAt(REVIEWED), headSha: fakeSha("other") } as Verdict]), NEW_HEAD)).toBeUndefined();
  });

  it("has no source when the only review is at the head itself", () => {
    expect(carriedSource(reviews([NEW_HEAD, mergeAt(NEW_HEAD)]), NEW_HEAD)).toBeUndefined();
  });
});

describe("the seat check of a carry", () => {
  const seat = (name: string): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy: null, predecessor: null });
  const verdict = (head: string, value: "MERGE" | "FIX_FIRST" | "WAIT", from: ReviewerAgent): ReviewerMessage => ({
    agentId: from.agentId,
    sessionId: from.sessionId,
    writtenAt: 1,
    text: `Verdict: ${value}\nPR: ${REPO}#1\nHead: ${head}\n`,
    locator: { sourceId: "synthetic" } as unknown as ReviewerMessage["locator"],
  });

  async function checked(messages: (reviewer: ReviewerAgent) => ReviewerMessage[], withDispatch = true) {
    const reviewer = seat("tc-x-review");
    const wiring = { reader: { read: async () => messages(reviewer) }, ...(withDispatch && { dispatch: { roster: async () => [reviewer] } }) } as unknown as ReviewWiring;
    const route = carrySeatRoute({ now: () => 0 }, wiring);
    const prompt = JSON.stringify({ ...TARGET, heads: [REVIEWED, NEW_HEAD] });
    const outcome = await route.runner.run({ prompt, signal: new AbortController().signal, attempt: 0, requestKey: "k" } as unknown as RoutedStepInput);
    if (!outcome.ok) throw new Error(outcome.error);
    return (JSON.parse(outcome.output) as { result: { clear: boolean } }).result.clear;
  }

  it("refuses when a seat reviewer said FIX_FIRST at the carried head", async () => {
    await expect(checked((reviewer) => [verdict(NEW_HEAD, "FIX_FIRST", reviewer)])).resolves.toBe(false);
  });

  it("refuses when a seat reviewer said FIX_FIRST at a head between", async () => {
    await expect(checked((reviewer) => [verdict(REVIEWED, "FIX_FIRST", reviewer)])).resolves.toBe(false);
  });

  it("refuses when a seat reviewer said WAIT at the carried head, as its checks had not finished", async () => {
    await expect(checked((reviewer) => [verdict(NEW_HEAD, "WAIT", reviewer)])).resolves.toBe(false);
  });

  it("refuses when a seat reviewer said WAIT at a head between", async () => {
    await expect(checked((reviewer) => [verdict(REVIEWED, "WAIT", reviewer)])).resolves.toBe(false);
  });

  it("clears when no seat reviewer objected", async () => {
    await expect(checked((reviewer) => [verdict(NEW_HEAD, "MERGE", reviewer)])).resolves.toBe(true);
  });
});
