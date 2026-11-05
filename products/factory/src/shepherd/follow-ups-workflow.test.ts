import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerReader } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { fakeActiveWork } from "../test-support/active-work.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { activeWorkFollowUpTasks } from "./cleanup-ports.js";
import type { FollowUpTasks } from "./follow-ups-file.js";
import { FOLLOW_UPS_STEP, fileFollowUpsAt, followUpsBody } from "./follow-ups-step.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { shepherdPrWorkflow } from "./pr.js";
import { AWAIT_VERDICT_STEP, reviewPhase } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const ORIGIN = "http://127.0.0.1:7400";
const PARENT = { id: "DM-1", status: "open", done_when: "Parent done.", notes: "", tags: [] };
const BLOCK = "Follow-ups:\n- Cache the head lookup | A second lookup at one head reads the cache | medium\n- Name the retry bound | The bound is a named constant | low";
const MALFORMED = "Follow-ups:\n- Cache the head lookup | medium";
const mergeText = (head: string, block = "") => `Read it all.\n\n${block}\n\nVerdict: MERGE\nPR: ${REPO}#1\nHead: ${head}\n`;
const fixFirstText = (head: string, block = "") => `1. The guard reads $1 unquoted.\n\nDefect class: unquoted shell words.\n\n${block}\n\nVerdict: FIX_FIRST\nPR: ${REPO}#1\nHead: ${head}\n`;

const row = (name: string): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "exited", spawnedBy: "coord", predecessor: null });

function locatorIn(sessionId: string): SourceTextLocator {
  const conversation = { harness: "claude-code", namespace: "test", nativeId: sessionId };
  const source = { sourceId: sessionId, harness: "claude-code", format: "claude-code-jsonl", formatVersion: null, path: "transcript.jsonl", namespace: "test", conversation, provenance: { kind: "claude-code-transcript" as const, legacySessionId: sessionId } };
  const evidence = { line: { sourceId: sessionId, byteOffset: 0, byteLength: 1, contentHash: "0", lineNumber: 1, nativeOrdinal: null }, subrecord: { index: 0, path: ["message"] } };
  return { source, evidence, selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } };
}

/** Every reviewer Shepherd spawns answers the head it reads with `textAt(head)`. */
function reviewers(textAt: (head: string) => string): { dispatch: ReviewerDispatch; reader: ReviewerReader } {
  const agents: ReviewerAgent[] = [{ ...row("coord"), presence: "live", spawnedBy: null }, row("impl-a")];
  const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name) => void agents.push(row(name)), resume: async () => undefined };
  const reader: ReviewerReader = {
    read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => ({ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text: textAt(input.head), locator: locatorIn(who.sessionId) })),
  };
  return { dispatch, reader };
}

interface Options {
  text: (head: string) => string;
  followUps?: FollowUpTasks;
  task?: string;
}

/** One PR at H1, green CI, on an auto-merge policy; a wake records its request and hands the round back. */
function world({ text, followUps, task = "demo/DM-1" }: Options) {
  const fake = fakeGitHub();
  const wakes: WakeRequest[] = [];
  const wake: ShepherdPhases["wake"] = async (_ctx, request) => (wakes.push(request), { kind: "unhandled", reason: "no fixer in this test" });
  const ref = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review: { ...reviewers(text), roles: { g10: "bd-reviewer", standard: "reviewer" }, ...(followUps && { followUps }) } });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified", additions: 10, deletions: 0 }]);
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY), ...(task !== "" && { task }) });
  ref.get().register({ repo: REPO, pr: 1, runId, task: task || "demo/DM-1", implementer: "impl-a", policy: AUTO_POLICY, kind: "correctness" });
  const results = () => Object.values(host.runtime.status(runId)!.stepResults);
  const followUpsResult = () => results().find((result) => result.stepId.startsWith(`${FOLLOW_UPS_STEP}:`))?.data?.["result"];
  return { wakes, merged: () => fake.pr(1).merged, stepIds: () => results().map((result) => result.stepId), followUpsResult };
}

function awOver(tasks = [PARENT]) {
  const aw = fakeActiveWork(tasks);
  return { aw, port: activeWorkFollowUpTasks({ origin: ORIGIN, fetch: aw.fetch }) };
}

function after(ids: string[], prefix: string): string | undefined {
  const at = ids.findIndex((id) => id.startsWith(prefix));
  return at < 0 ? undefined : ids[at + 1];
}
const merges = (w: ReturnType<typeof world>) => vi.waitFor(() => expect(w.merged()).toBe(true), { timeout: 5_000 });

describe("the sh-follow-ups step at a verdict", () => {
  it("a MERGE carrying follow-ups merges and files each one, recording the ids in the sh-follow-ups step", async () => {
    const { aw, port } = awOver();
    const w = world({ text: (head) => mergeText(head, BLOCK), followUps: port });

    await merges(w);

    const filed = [...aw.tasks.values()].filter((task) => task.tags.includes("follow-up:DM-1"));
    expect(filed.map((task) => task.title)).toEqual(["Cache the head lookup", "Name the retry bound"]);
    expect(w.followUpsResult()).toEqual({ filed: filed.map((task) => ({ title: task.title, id: task.id, deduped: false })) });
    expect(aw.tasks.get("DM-1")!.notes).toContain(filed[0]!.id);
  });

  it("a malformed Follow-ups block files nothing, records its named warning, and the MERGE still merges", async () => {
    const { aw, port } = awOver();
    const w = world({ text: (head) => mergeText(head, MALFORMED), followUps: port });

    await merges(w);

    expect(w.followUpsResult()).toEqual({ filed: [], warning: "bad_item" });
    expect(aw.calls).toEqual([]);
  });

  it("an active-work outage while filing records the error and the MERGE still merges", async () => {
    const port = activeWorkFollowUpTasks({ origin: ORIGIN, fetch: () => Promise.reject(new Error("connect ECONNREFUSED")) });
    const w = world({ text: (head) => mergeText(head, BLOCK), followUps: port });

    await merges(w);

    expect(w.followUpsResult()).toEqual({ filed: [], error: expect.stringContaining("ECONNREFUSED") });
  });

  it("a throwing active-work port leaves the verdict and the step after it as a run with no follow-ups has them", async () => {
    const throwing: FollowUpTasks = {
      openTasks: () => {
        throw new TypeError("port exploded");
      },
      add: () => Promise.reject(new Error("unreached")),
      appendNote: () => Promise.reject(new Error("unreached")),
    };
    const control = world({ text: (head) => mergeText(head) });
    const w = world({ text: (head) => mergeText(head, BLOCK), followUps: throwing });

    await merges(control);
    await merges(w);

    expect(w.followUpsResult()).toEqual({ filed: [], error: "TypeError: port exploded" });
    expect(after(w.stepIds(), FOLLOW_UPS_STEP)).toBe(after(control.stepIds(), `${AWAIT_VERDICT_STEP}:`));
    expect(after(w.stepIds(), FOLLOW_UPS_STEP)).toBe(`sh-publish-review:${H1}`);
  });

  it("a run registered without a task records no-task and files nothing", async () => {
    const { aw, port } = awOver();
    const w = world({ text: (head) => mergeText(head, BLOCK), followUps: port, task: "" });

    await merges(w);

    expect(w.followUpsResult()).toEqual({ filed: [], skipped: "no-task" });
    expect(aw.calls).toEqual([]);
  });

  it("a FIX_FIRST carrying follow-ups files them and the FIX_FIRST still goes to the fixer", async () => {
    const { aw, port } = awOver();
    const w = world({ text: (head) => fixFirstText(head, BLOCK), followUps: port });

    await vi.waitFor(() => expect(w.wakes).toHaveLength(1), { timeout: 5_000 });

    expect(w.wakes[0]).toMatchObject({ kind: "review", headSha: H1 });
    expect([...aw.tasks.values()].filter((task) => task.tags.includes("follow-up:DM-1"))).toHaveLength(2);
    expect(w.merged()).toBe(false);
  });

  it("a verdict with no Follow-ups block records no sh-follow-ups step", async () => {
    const { aw, port } = awOver();
    const w = world({ text: (head) => mergeText(head), followUps: port });

    await merges(w);

    expect(w.stepIds().some((id) => id.startsWith(FOLLOW_UPS_STEP))).toBe(false);
    expect(aw.calls).toEqual([]);
  });
});

describe("fileFollowUpsAt on replay", () => {
  const verdict = { kind: "verdict" as const, verdict: "MERGE" as const, head: H1, locator: {}, reviewer: { agentId: "agent-r", sessionId: "s" }, followUps: [{ title: "Cache it", doneWhen: "Cached", severity: "low" as const }] };
  const ctxWith = (recordedNext: string | undefined) => {
    const dispatch = vi.fn(async () => ({ data: { result: { filed: [] } } }));
    return { dispatch, ctx: partialFake<WorkflowContext>({ runId: "run-1", dispatch, historyNext: () => recordedNext, param: () => "demo/DM-1" }) };
  };

  it("a run replaying a ledger recorded before sh-follow-ups existed skips the step", async () => {
    const { ctx, dispatch } = ctxWith(`merge-evidence:${H1}`);

    await fileFollowUpsAt(ctx, { repo: REPO, pr: 1, head: H1 }, verdict);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a run whose ledger already holds the step replays it", async () => {
    const { ctx, dispatch } = ctxWith(`${FOLLOW_UPS_STEP}:${H1}`);

    await fileFollowUpsAt(ctx, { repo: REPO, pr: 1, head: H1 }, verdict);

    expect(dispatch).toHaveBeenCalledOnce();
  });
});

describe("followUpsBody's bound", () => {
  it("an active-work call that never answers records an error once the bound passes", async () => {
    const hung: FollowUpTasks = { openTasks: () => new Promise(() => undefined), add: async () => "x", appendNote: async () => undefined };
    const input = { runId: "run-1", task: "demo/DM-1", repo: REPO, pr: 1, head: H1, reviewer: "agent-r", followUps: [{ title: "Cache it", doneWhen: "Cached", severity: "low" as const }] };

    const result = await followUpsBody(hung, input, new AbortController().signal, 20);

    expect(result).toEqual({ filed: [], error: expect.stringContaining("TimeoutError") });
  });
});
