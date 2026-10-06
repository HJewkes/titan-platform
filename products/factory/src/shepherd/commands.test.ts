import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSha } from "@titan-design/github";
import type { StepResult } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture, shepherdRuns, type FixtureOptions, type ShepherdFixture } from "../test-support/shepherd.js";
import type { MergeEvaluation, Registered } from "./commands.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { PrTimelineSchema, WatchRowSchema, type PrTimeline, type WatchRow } from "./view.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World extends ShepherdFixture {
  host: FactoryHost;
  call: <T>(name: string, args: unknown) => ReturnType<typeof callCommand<T>>;
}

function world(options: FixtureOptions & { dbPath?: string } = {}): World {
  const fixture = shepherdFixture(options);
  const host = openFactoryHost({ dbPath: options.dbPath ?? ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  return { ...fixture, host, call: (name, args) => callCommand(host, fixture.routes, name, args) };
}

const pr1 = { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" };

async function registered(w: World, args: object): Promise<Registered> {
  const envelope = await w.call<Registered>("shepherd.register", args);
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
}

/** A registration whose run has already failed: a run started with a malformed `after` list fails before any step reads GitHub. */
async function failedRegistration(w: World, slice?: string, kind?: "correctness"): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", branch: BRANCH, policy: JSON.stringify(OWNER_GATE_POLICY), task: "demo/T-1", after: "not json" });
  await w.host.runtime.wait(runId);
  w.routes.shepherd!.store.get().register({ ...pr1, branch: BRANCH, runId, policy: OWNER_GATE_POLICY, slice, kind });
  expect(w.host.runtime.status(runId)?.status).toBe("failed");
  return runId;
}

describe("shepherd.register", () => {
  it("a second register for the same repo#pr returns the first run, starts no other, and updates the metadata", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const first = await registered(w, pr1);
    const second = await registered(w, { ...pr1, implementer: "impl-b", reviewer: "rev-a" });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ runId: first.runId, created: false, registration: { implementer: "impl-b", reviewer: "rev-a" } });
    expect(shepherdRuns(w.host)).toEqual([first.runId]);
  });

  it("a branch registered before its PR opens and that PR registered later share one run", async () => {
    const w = world({ frozen: true });
    const byBranch = await registered(w, { repo: REPO, branch: BRANCH, task: "demo/T-1", implementer: "impl-a" });
    await vi.waitFor(() => expect(w.fake.calls).toContain("listPrs"));
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const byPr = await registered(w, pr1);

    expect(byPr).toMatchObject({ runId: byBranch.runId, created: false, registration: { pr: 1, branch: BRANCH } });
    expect(shepherdRuns(w.host)).toEqual([byBranch.runId]);
  });

  it("a PR registered first is found by a later registration of its head branch", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const byPr = await registered(w, pr1);

    const byBranch = await registered(w, { repo: REPO, branch: BRANCH, task: "demo/T-1", implementer: "impl-a" });

    expect(byBranch).toMatchObject({ runId: byPr.runId, created: false });
    expect(shepherdRuns(w.host)).toEqual([byPr.runId]);
  });

  it("a repo on a seat deny list is refused with an error envelope and starts no run", async () => {
    const w = world({ seats: { seats: [], denied: [REPO] } });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const envelope = await w.call("shepherd.register", pr1);

    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/registration refused/) });
    expect(shepherdRuns(w.host)).toEqual([]);
    expect(await w.call("shepherd.status", {})).toEqual({ ok: true, data: [] });
  });

  it("a PR whose head is not the branch given is refused and starts no run", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: "agent-chat/other" });

    const envelope = await w.call("shepherd.register", { ...pr1, branch: BRANCH });

    expect(envelope).toMatchObject({ ok: false });
    expect(shepherdRuns(w.host)).toEqual([]);
  });
});

describe("shepherd.register races", () => {
  it("a crash between starting the run and writing its registration leaves neither", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const store = w.routes.shepherd!.store.get();
    vi.spyOn(store, "register").mockImplementationOnce(() => {
      throw new Error("process died mid-register");
    });

    const envelope = await w.call("shepherd.register", pr1);

    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/process died mid-register/) });
    expect(shepherdRuns(w.host)).toEqual([]);
    expect(store.all()).toEqual([]);
  });

  it("two hosts on one database registering the same repo#pr yield exactly one run", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp-571-")), "factory.db");
    const cli = world({ frozen: true, dbPath });
    const serve = world({ frozen: true, dbPath });
    for (const w of [cli, serve]) w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const serveStore = serve.routes.shepherd!.store.get();
    const first = await registered(cli, pr1);
    vi.spyOn(serveStore, "byPr").mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
    vi.spyOn(serveStore, "byBranch").mockReturnValueOnce(undefined);

    const second = await registered(serve, pr1);

    expect(second).toMatchObject({ runId: first.runId, created: false });
    expect(shepherdRuns(cli.host)).toEqual([first.runId]);
    expect(serveStore.all().map((registration) => registration.runId)).toEqual([first.runId]);
  });

  it("a repeat register cannot widen the stored merge policy", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    await registered(w, { ...pr1, policy: { merge: "never" } });

    const again = await registered(w, pr1);

    expect(again.registration.policy.merge).toBe("never");
  });
});

describe("shepherd.register kind", () => {
  it("a repeat that would move a correctness run to unknown is refused and keeps the stored kind", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    await registered(w, { ...pr1, kind: "correctness" });

    const envelope = await w.call("shepherd.register", { ...pr1, kind: "unknown" });

    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/correctness.*unknown/) });
    expect((await registered(w, pr1)).registration.kind).toBe("correctness");
  });
});

describe("shepherd.register kind on a failed run", () => {
  it("a refused kind move leaves the failed run, its registration and the run count untouched", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const failedRunId = await failedRegistration(w, undefined, "correctness");

    const envelope = await w.call("shepherd.register", { ...pr1, implementer: "impl-z", kind: "unknown" });

    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/correctness.*unknown/) });
    expect(shepherdRuns(w.host)).toEqual([failedRunId]);
    expect(w.routes.shepherd!.store.get().byPr(REPO, 1)).toMatchObject({ runId: failedRunId, implementer: pr1.implementer });
  });
});

describe("shepherd.register slice", () => {
  it("a re-register without a slice keeps the stored slice", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    await registered(w, { ...pr1, slice: "S4" });

    const again = await registered(w, { ...pr1, implementer: "impl-b" });

    expect(again.registration.slice).toBe("S4");
  });

  it("a re-register with a new slice replaces the stored one", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    await registered(w, { ...pr1, slice: "S4" });

    const again = await registered(w, { ...pr1, slice: "S5" });

    expect(again.registration.slice).toBe("S5");
  });

  it("noSlice clears the stored slice", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    await registered(w, { ...pr1, slice: "S4" });

    const again = await registered(w, { ...pr1, noSlice: true });

    expect(again.registration.slice).toBeNull();
  });

  it("a slice and noSlice together are refused", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const envelope = await w.call("shepherd.register", { ...pr1, slice: "S4", noSlice: true });

    expect(envelope.ok).toBe(false);
  });

  it("a re-register after a failed run keeps the slice on the new run", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const failedRunId = await failedRegistration(w, "S4");

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ created: true, previousRunId: failedRunId, registration: { slice: "S4" } });
  });
});

describe("shepherd.register after a failed run", () => {
  it("a failed run gets a new run, the registration moves to it, and the old run still reads", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const failedRunId = await failedRegistration(w);

    const again = await registered(w, { ...pr1, implementer: "impl-b" });

    expect(again).toMatchObject({ created: true, previousRunId: failedRunId, registration: { runId: again.runId, pr: 1, branch: BRANCH, implementer: "impl-b" } });
    expect(again.runId).not.toBe(failedRunId);
    expect(w.host.runtime.status(failedRunId)?.status).toBe("failed");
    expect(w.host.runtime.status(again.runId)?.status).toBe("running");
    expect(w.routes.shepherd!.store.get().byPr(REPO, 1)?.runId).toBe(again.runId);
    expect(await w.call("shepherd.status", { repo: REPO, pr: 1 })).toMatchObject({ ok: true, data: [{ runId: again.runId }] });
    expect(await w.call("shepherd.timeline", { repo: REPO, pr: 1 })).toMatchObject({ ok: true, data: { row: { runId: again.runId } } });
  });

  it("the failed run's authors move to the new run, where cleanup and wake read them", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const failedRunId = await failedRegistration(w);
    const store = w.routes.shepherd!.store.get();
    store.recordAuthor(failedRunId, { agentId: "a-1", name: "impl-a", role: "implementer" });
    store.recordAuthor(failedRunId, { agentId: "a-2", name: "impl-a-2", role: "successor", predecessor: "a-1" });

    const again = await registered(w, pr1);

    expect(store.authorsOf(again.runId).map((author) => author.name)).toEqual(["impl-a", "impl-a-2"]);
    expect(store.authorsOf(again.registration.runId).filter((author) => author.role === "successor").map((author) => author.name)).toEqual(["impl-a-2"]);
    expect(store.authorsOf(failedRunId)).toEqual([]);
  });

  it("two registers after one failure start exactly one new run", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const failedRunId = await failedRegistration(w);

    const [first, second] = await Promise.all([registered(w, pr1), registered(w, pr1)]);

    expect(first).toMatchObject({ created: true, previousRunId: failedRunId });
    expect(second).toMatchObject({ created: false, runId: first.runId });
    expect(second.previousRunId).toBeUndefined();
    expect(shepherdRuns(w.host)).toHaveLength(2);
  });

  it("a running run comes back unchanged", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const first = await registered(w, pr1);

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ runId: first.runId, created: false });
    expect(again.previousRunId).toBeUndefined();
  });

  it("a recovery_required run comes back unchanged", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const first = await registered(w, pr1);
    const status = w.host.runtime.status.bind(w.host.runtime);
    vi.spyOn(w.host.runtime, "status").mockImplementation((id) => ({ ...status(id)!, status: "recovery_required" }));

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ runId: first.runId, created: false });
    expect(again.previousRunId).toBeUndefined();
    expect(shepherdRuns(w.host)).toEqual([first.runId]);
  });

  it("a cancelled run comes back unchanged", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const first = await registered(w, pr1);
    w.host.runtime.cancel(first.runId, "test");
    await w.host.runtime.wait(first.runId);

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ runId: first.runId, created: false });
    expect(shepherdRuns(w.host)).toEqual([first.runId]);
  });

  it("a completed run comes back unchanged", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH, state: "closed", merged: true, mergeSha: H1 });
    const first = await registered(w, pr1);
    await w.host.runtime.wait(first.runId);
    expect(w.host.runtime.status(first.runId)?.status).toBe("completed");

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ runId: first.runId, created: false });
    expect(shepherdRuns(w.host)).toEqual([first.runId]);
  });
});

const FIXED = fakeSha("cc749-fixed-head");

/** A run whose PR conflicts and whose conflict wake no agent takes, so it ends stopped not-mergeable at H1. */
async function stoppedNotMergeable(w: World): Promise<string> {
  w.fake.addPr({ headSha: H1, headRef: BRANCH, mergeableState: "dirty" });
  const { runId } = await registered(w, pr1);
  await w.host.runtime.wait(runId);
  return runId;
}

function stoppedStep(reason: string): StepResult {
  return { stepId: "sh-stopped", iteration: 0, operation: "dispatch", agentId: null, signal: null, completedAt: "2026-10-05T00:00:00Z", data: { result: { reason } } };
}

const LANDED: StepResult = { stepId: "sh-landed", iteration: 0, operation: "dispatch", agentId: null, signal: null, completedAt: "2026-10-05T00:00:00Z", data: { result: { mergeSha: H1 } } };

/** The registered run reads as completed with `result` as its only recorded outcome step. */
async function endedAs(w: World, result: StepResult): Promise<string> {
  w.fake.addPr({ headSha: H1, headRef: BRANCH });
  const { runId } = await registered(w, pr1);
  const status = w.host.runtime.status.bind(w.host.runtime);
  vi.spyOn(w.host.runtime, "status").mockImplementation((id) => (id === runId ? { ...status(id)!, status: "completed", stepResults: { [`${result.stepId}:0`]: result } } : status(id)));
  return runId;
}

describe("shepherd.register after a stopped run", () => {
  it("a run stopped not-mergeable gets a new run at the pull request's current head", async () => {
    const w = world();
    const stoppedRunId = await stoppedNotMergeable(w);
    Object.assign(w.fake.pr(1), { mergeableState: "clean" });
    w.fake.pushHead(1, FIXED);

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ created: true, previousRunId: stoppedRunId, previousStop: "not-mergeable", registration: { runId: again.runId } });
    await gateOpened(w.host, gateId(again.runId, "approve-merge"));
    expect(w.host.gates.get(gateId(again.runId, "approve-merge"))?.prompt).toContain(`at head ${FIXED}`);
    expect(w.host.runtime.status(stoppedRunId)?.status).toBe("completed");
    expect(shepherdRuns(w.host)).toHaveLength(2);
  });

  it("a run stopped on a conflict gets a new run", async () => {
    const w = world({ frozen: true });
    const stoppedRunId = await endedAs(w, stoppedStep("conflict"));

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ created: true, previousRunId: stoppedRunId, previousStop: "conflict" });
    expect(w.routes.shepherd!.store.get().byPr(REPO, 1)?.runId).toBe(again.runId);
  });

  it.each([
    ["merged", LANDED],
    ["abandoned", stoppedStep("abandoned")],
    ["closed", stoppedStep("closed")],
    ["stuck-behind", stoppedStep("stuck-behind")],
    ["merge-denied", stoppedStep("merge-denied")],
  ])("a run that ended %s starts nothing and only updates the metadata", async (_ended, result) => {
    const w = world({ frozen: true });
    const runId = await endedAs(w, result);

    const again = await registered(w, { ...pr1, implementer: "impl-b" });

    expect(again).toMatchObject({ runId, created: false, registration: { implementer: "impl-b" } });
    expect(again.previousRunId).toBeUndefined();
    expect(shepherdRuns(w.host)).toEqual([runId]);
  });

  it("a run stopped not-mergeable whose pull request has since closed starts nothing", async () => {
    const w = world({ frozen: true });
    const runId = await endedAs(w, stoppedStep("not-mergeable"));
    Object.assign(w.fake.pr(1), { state: "closed" });

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ runId, created: false });
    expect(shepherdRuns(w.host)).toEqual([runId]);
  });
});

describe("shepherd.merge", () => {
  it("on an owner-gated run parked on approve-merge reports the gate and leaves it pending", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    await gateOpened(w.host, gateId(runId, "approve-merge"));

    const envelope = await w.call<MergeEvaluation>("shepherd.merge", { repo: REPO, pr: 1 });

    expect(envelope).toMatchObject({ ok: true, data: { runId, phase: "awaiting-approval", decision: { outcome: "gate" }, pendingGate: { stepId: "approve-merge" }, held: null } });
    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
    expect(w.host.runtime.status(runId)?.status).toBe("paused");
    expect(w.fake.effects.merge).toBe(0);
  });

  it("reports a hold, and release clears it", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);

    const hold = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "owner wants a look" });
    const whileHeld = await w.call<MergeEvaluation>("shepherd.merge", { repo: REPO, pr: 1 });
    await w.call("shepherd.release", { repo: REPO, pr: 1 });
    const released = await w.call<MergeEvaluation>("shepherd.merge", { repo: REPO, pr: 1 });

    expect(hold).toEqual({ ok: true, data: { runId, held: { reason: "owner wants a look" } } });
    expect(whileHeld).toMatchObject({ ok: true, data: { held: { reason: "owner wants a look" } } });
    expect(released).toMatchObject({ ok: true, data: { held: null } });
  });

  it("records a hold's --reviewer and refuses one with whitespace", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);

    const named = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "awaiting the audit", reviewer: "sec-audit-review" });
    const refused = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "awaiting the audit", reviewer: "two words" });

    expect(named).toEqual({ ok: true, data: { runId, held: { reason: "awaiting the audit", reviewer: "sec-audit-review" } } });
    expect(refused).toMatchObject({ ok: false });
  });
});

describe("shepherd reads", () => {
  it("list and timeline return the TP-466 watch-row and timeline shapes", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    await gateOpened(w.host, gateId(runId, "approve-merge"));

    const list = await w.call<WatchRow[]>("shepherd.list", {});
    const timeline = await w.call<PrTimeline>("shepherd.timeline", { repo: REPO, pr: 1 });

    if (!list.ok || !timeline.ok) throw new Error("read failed");
    expect(list.data.map((row) => WatchRowSchema.parse(row))).toMatchObject([
      { runId, pr: 1, branch: BRANCH, phase: "awaiting-approval", headSha: H1, nextAction: "owner: resolve approve-merge", held: null, stalled: null },
    ]);
    const { entries } = PrTimelineSchema.parse(timeline.data);
    expect(entries).toContainEqual(expect.objectContaining({ kind: "ci", headSha: H1, conclusion: "green" }));
    expect(entries.at(-1)).toMatchObject({ kind: "gate", gateId: gateId(runId, "approve-merge"), status: "pending" });
  });

  it("list leaves finished runs out by default", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    w.host.runtime.cancel(runId, "test");
    await w.host.runtime.wait(runId);

    const active = await w.call("shepherd.list", {});
    const finished = await w.call<WatchRow[]>("shepherd.list", { state: "finished" });

    expect(active).toEqual({ ok: true, data: [] });
    expect(finished).toMatchObject({ ok: true, data: [{ runId, phase: "cancelled" }] });
  });
});
