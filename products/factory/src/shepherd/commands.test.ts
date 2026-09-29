import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture, shepherdRuns, type FixtureOptions, type ShepherdFixture } from "../test-support/shepherd.js";
import type { MergeEvaluation, Registered } from "./commands.js";
import { PrTimelineSchema, WatchRowSchema, type PrTimeline, type WatchRow } from "./view.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World extends ShepherdFixture {
  host: FactoryHost;
  call: <T>(name: string, args: unknown) => ReturnType<typeof callCommand<T>>;
}

function world(options: FixtureOptions = {}): World {
  const fixture = shepherdFixture(options);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  return { ...fixture, host, call: (name, args) => callCommand(host, fixture.routes, name, args) };
}

const pr1 = { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" };

async function registered(w: World, args: object): Promise<Registered> {
  const envelope = await w.call<Registered>("shepherd.register", args);
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
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
