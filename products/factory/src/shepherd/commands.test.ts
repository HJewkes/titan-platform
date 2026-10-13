import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase } from "@titan-design/store-sqlite";
import type { StepResult } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture, shepherdRuns, type FixtureOptions, type ShepherdFixture } from "../test-support/shepherd.js";
import { AccountLimitStore } from "./account-store.js";
import type { MergeEvaluation, Registered } from "./commands.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { ShepherdStore } from "./store.js";
import { PrTimelineSchema, WatchRowSchema, type PrTimeline, type WatchRow } from "./view.js";
import type { Waiting } from "./waiting.js";

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
const H2 = fakeSha("head2");

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

describe("shepherd.waiting", () => {
  it("lists nothing when no run waits", async () => {
    const w = world({ frozen: true });

    expect(await w.call("shepherd.waiting", {})).toEqual({ ok: true, data: { owner: [], seat: [] } });
  });

  it("marks an approve-merge gate current when the head its prompt names is the run's head", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    await gateOpened(w.host, gateId(runId, "approve-merge"));

    const envelope = await w.call<Waiting>("shepherd.waiting", {});

    expect(envelope).toMatchObject({ ok: true, data: { owner: [{ gateId: gateId(runId, "approve-merge"), head: H1, headIsCurrent: true }], seat: [] } });
  });
});

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

  it("an owner-gate request with no reason is refused naming the four reasons, and starts no run", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const envelope = await w.call("shepherd.register", { ...pr1, policy: { merge: "owner-gate" } });

    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/registration refused.*gate-2-visual, g10-security, proof-fixture, owner-asked/) });
    expect(shepherdRuns(w.host)).toEqual([]);
  });

  it("an owner-gate request with a reason registers and stores it", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const { registration } = await registered(w, { ...pr1, policy: { merge: "owner-gate", ownerGateReason: "proof-fixture" } });

    expect(registration.policy).toMatchObject({ merge: "owner-gate", ownerGateReason: "proof-fixture" });
  });

  it("a PR whose head is not the branch given is refused and starts no run", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: "agent-chat/other" });

    const envelope = await w.call("shepherd.register", { ...pr1, branch: BRANCH });

    expect(envelope).toMatchObject({ ok: false });
    expect(shepherdRuns(w.host)).toEqual([]);
  });
});

describe("shepherd.register from facts", () => {
  const facts = { ...pr1, branch: BRANCH, head: H1, base: "main", kind: "feature" };

  it("reads nothing from GitHub when the head, base and branch are passed, and stores the head and base", async () => {
    const reads: string[] = [];
    const github = fakeGitHub();
    github.addPr({ headSha: H1, headRef: BRANCH });
    const refused = async (): Promise<never> => Promise.reject(new Error("register read GitHub"));
    const port = { ...githubPort(github.wire), getPr: refused, listPrFiles: refused };
    const w = world({ frozen: true, port, prFiles: async ({ head }) => (reads.push(head), [{ path: "packages/x/src/a.ts", status: "modified", additions: 3, deletions: 1 }]) });

    const { registration, g10Hold } = await registered(w, facts);

    expect(reads).toEqual([H1]);
    expect(g10Hold).toBeUndefined();
    expect(registration).toMatchObject({ headSha: H1, base: "main", branch: BRANCH });
  });

  it("holds a large diff read from git, and a repeat at a new head stores that head", async () => {
    const lines = new Map([[H1, 10], [H2, 500]]);
    const w = world({ frozen: true, prFiles: async ({ head }) => [{ path: "packages/x/src/a.ts", status: "modified", additions: lines.get(head) ?? 0, deletions: 0 }] });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const first = await registered(w, facts);
    const second = await registered(w, { ...facts, head: H2 });

    expect(first.g10Hold).toBeUndefined();
    expect(second).toMatchObject({ g10Hold: "g10-review: 500 changed lines", registration: { headSha: H2, base: "main" } });
  });

  it("refuses a head that is not a full sha", async () => {
    const w = world({ frozen: true });

    expect(await w.call("shepherd.register", { ...facts, head: "abc123" })).toMatchObject({ ok: false });
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

  it("a new registration with no kind stores correctness", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const { registration } = await registered(w, pr1);

    expect(registration.kind).toBe("correctness");
  });

  it("a kindless repeat of a feature run keeps feature and is not refused", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    await registered(w, { ...pr1, kind: "feature" });

    const envelope = await w.call<Registered>("shepherd.register", pr1);

    expect(envelope).toMatchObject({ ok: true, data: { created: false, registration: { kind: "feature" } } });
  });
});

describe("shepherd.register G10 hold", () => {
  const large = [{ path: "packages/x/src/a.ts", status: "modified", additions: 450, deletions: 0 }];

  it("a new registration of a PR over 400 lines comes back held g10-review by Shepherd", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    w.fake.prFiles.set(1, large);

    const result = await registered(w, pr1);

    expect(result).toMatchObject({ created: true, g10Hold: "g10-review: 450 changed lines", registration: { held: true, holdReason: "g10-review: 450 changed lines" } });
    expect(w.routes.shepherd!.store.get().eventsOf(result.runId)).toEqual([expect.objectContaining({ kind: "hold", actor: "shepherd" })]);
  });

  it("a repeat registration whose diff grew past 400 lines stacks a G10 hold over the seat's hold", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    w.fake.prFiles.set(1, large);
    const store = w.routes.shepherd!.store.get();
    store.hold(runId, "visual-gate2: screenshots pending");

    const repeat = await registered(w, pr1);

    expect(repeat).toMatchObject({ created: false, g10Hold: "g10-adversary: 450 changed lines, over a visual-gate2 hold" });
    expect(store.release(runId).holdReason).toBe("visual-gate2: screenshots pending");
  });

  it("a repeat registration whose diff grew into an authority path escalates a released g10-review hold to g10-adversary", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    w.fake.prFiles.set(1, large);
    const { runId } = await registered(w, pr1);
    const store = w.routes.shepherd!.store.get();
    store.releaseIfHeld(runId, "g10-review: 450 changed lines");
    w.fake.prFiles.set(1, [...large, { path: "packages/authority/src/x.ts", status: "modified", additions: 5, deletions: 0 }]);

    const repeat = await registered(w, pr1);

    expect(repeat).toMatchObject({ created: false, g10Hold: "g10-adversary: authority touch", registration: { held: true } });
  });

  it("a repeat registration of an unchanged diff leaves a released G10 hold released", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    w.fake.prFiles.set(1, large);
    const { runId } = await registered(w, pr1);
    const store = w.routes.shepherd!.store.get();
    store.releaseIfHeld(runId, "g10-review: 450 changed lines");

    const repeat = await registered(w, pr1);

    expect(repeat).toMatchObject({ created: false, registration: { held: false } });
    expect(repeat.g10Hold).toBeUndefined();
  });

  it("a repeat registration whose changed files cannot be read is held g10-adversary", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    await registered(w, pr1);
    w.fake.prChangedFiles.set(1, 5000);

    const repeat = await registered(w, pr1);

    expect(repeat).toMatchObject({ created: false, g10Hold: "g10-adversary: changed files unread at registration (FileListTruncatedError)" });
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

  it("the failed run's own account hold moves to the new run, which owns it", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp-2385-")), "factory.db");
    const w = world({ frozen: true, dbPath });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const failedRunId = await failedRegistration(w);
    const db = openDatabase(dbPath);
    const limits = new AccountLimitStore(db);
    expect(limits.holdRun(failedRunId, "account-exhausted: /accounts/review; TP-2385")).toBe(true);

    try {
      const again = await registered(w, pr1);

      expect(limits.holdsRun(again.runId)).toBe(true);
      expect(limits.holdsRun(failedRunId)).toBe(false);
      expect(db.prepare("SELECT run_id FROM shepherd_account_hold").all()).toEqual([{ run_id: again.runId }]);
    } finally {
      db.close();
    }
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

  it("the stopped run's authors move to the new run", async () => {
    const w = world({ frozen: true });
    const stoppedRunId = await endedAs(w, stoppedStep("not-mergeable"));
    const store = w.routes.shepherd!.store.get();
    store.recordAuthor(stoppedRunId, { agentId: "a-1", name: "impl-a", role: "implementer" });
    store.recordAuthor(stoppedRunId, { agentId: "a-2", name: "impl-a-2", role: "successor", predecessor: "a-1" });

    const again = await registered(w, pr1);

    expect(store.authorsOf(again.runId).map((author) => author.name)).toEqual(["impl-a", "impl-a-2"]);
    expect(store.authorsOf(stoppedRunId)).toEqual([]);
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

  it("a run whose gate was abandoned gets a new run at the current head with the current seat book's policy", async () => {
    const w = world({ frozen: true });
    const abandonedRunId = await endedAs(w, stoppedStep("abandoned"));
    w.fake.pushHead(1, FIXED);

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ created: true, previousRunId: abandonedRunId, previousStop: "abandoned", registration: { runId: again.runId } });
    expect(again.runId).not.toBe(abandonedRunId);
    expect(w.routes.shepherd!.store.get().byPr(REPO, 1)?.runId).toBe(again.runId);
    expect(shepherdRuns(w.host)).toHaveLength(2);
  });

  it("a run abandoned on a pull request that has since closed starts nothing", async () => {
    const w = world({ frozen: true });
    const runId = await endedAs(w, stoppedStep("abandoned"));
    Object.assign(w.fake.pr(1), { state: "closed" });

    const again = await registered(w, pr1);

    expect(again).toMatchObject({ runId, created: false });
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

    const hold = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "no-reviewer: review step recorded none; TP-1" });
    const whileHeld = await w.call<MergeEvaluation>("shepherd.merge", { repo: REPO, pr: 1 });
    await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1 });
    const released = await w.call<MergeEvaluation>("shepherd.merge", { repo: REPO, pr: 1 });

    expect(hold).toEqual({ ok: true, data: { runId, held: { reason: "no-reviewer: review step recorded none; TP-1" } } });
    expect(whileHeld).toMatchObject({ ok: true, data: { held: { reason: "no-reviewer: review step recorded none; TP-1" } } });
    expect(released).toMatchObject({ ok: true, data: { held: null } });
  });

  it("records the head a release was made at, so a later move off it is known", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);

    await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "no-reviewer: review step recorded none; TP-1" });
    await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1 });

    expect(w.routes.shepherd!.store.get().eventsOf(runId).at(-1)).toMatchObject({ kind: "release", headSha: H1 });
  });

  it("refuses a release at a head the PR has moved past, and keeps the hold", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    const store = w.routes.shepherd!.store.get();
    store.hold(runId, "no-reviewer: review step recorded none; TP-1");
    w.fake.pr(1).headSha = fakeSha("pushed-after-review");

    const envelope = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1 });

    expect(envelope).toMatchObject({ ok: false, error: expect.stringContaining(`not ${H1}`) });
    expect(store.byRun(runId)?.held).toBe(true);
  });

  it("refuses a release on a run that is not held, and records no event", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);

    const envelope = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1 });

    expect(envelope).toMatchObject({ ok: false, error: expect.stringContaining("not held") });
    expect(w.routes.shepherd!.store.get().eventsOf(runId)).toEqual([]);
  });

  it("refuses a release when the PR's head cannot be read, and without a head", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    const store = w.routes.shepherd!.store.get();
    store.hold(runId, "no-reviewer: review step recorded none; TP-1");
    const missing = await w.call("shepherd.release", { repo: REPO, pr: 1 });
    w.fake.onGetPr = () => {
      throw new Error("github is down");
    };

    const unread = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1 });

    expect(missing).toMatchObject({ ok: false });
    expect(unread).toMatchObject({ ok: false, error: expect.stringContaining("could not be read") });
    expect(store.byRun(runId)?.held).toBe(true);
  });

  it("records the caller's actor on a hold and a release, and unknown when a client sends none", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    const reason = "no-reviewer: review step recorded none; TP-1";

    await w.call("shepherd.hold", { repo: REPO, pr: 1, reason, actor: "seat-a" });
    await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1, actor: "seat-b" });
    await w.call("shepherd.hold", { repo: REPO, pr: 1, reason });
    await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1 });

    const events = w.routes.shepherd!.store.get().eventsOf(runId);
    expect(events.map((event) => [event.kind, event.actor])).toEqual([["hold", "seat-a"], ["release", "seat-b"], ["hold", "unknown"], ["release", "unknown"]]);
  });

  it("records a hold's --reviewer and refuses one with whitespace", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);

    const named = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "g10-adversary: awaiting the audit", reviewer: "sec-audit-review" });
    const refused = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "g10-adversary: awaiting the audit", reviewer: "two words" });

    expect(named).toEqual({ ok: true, data: { runId, held: { reason: "g10-adversary: awaiting the audit", reviewer: "sec-audit-review" } } });
    expect(refused).toMatchObject({ ok: false });
  });
});

describe("shepherd.release with a g10-adversary hold over another", () => {
  const STALL = "stalled: no step progress; TP-2";
  const ADVERSARY = "g10-adversary: trust rule; TP-1";

  async function heldTwice(): Promise<{ w: World; runId: string }> {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: STALL, actor: "owner" });
    await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: ADVERSARY, actor: "seat" });
    return { w, runId };
  }

  it("refuses two releases that name no class, so neither lifts the adversary hold for the stall and the PR stays held", async () => {
    const { w, runId } = await heldTwice();
    const store = w.routes.shepherd!.store.get();

    const first = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1, actor: "owner" });
    const second = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1, actor: "owner" });

    expect([first, second]).toMatchObject([{ ok: false, error: expect.stringContaining("--class") }, { ok: false }]);
    expect(store.heldReason(REPO, 1)).toBe(ADVERSARY);
    expect(store.eventsOf(runId).map((event) => event.kind)).toEqual(["hold", "hold"]);
  });

  it("lifts only the named class, records its reason, and reports the adversary hold still in force", async () => {
    const { w, runId } = await heldTwice();
    const store = w.routes.shepherd!.store.get();

    const stall = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1, holdClass: "stalled", actor: "owner" });

    expect(stall).toEqual({ ok: true, data: { runId, held: { reason: ADVERSARY } } });
    expect(store.eventsOf(runId).filter((event) => event.kind === "release").map((event) => [event.reason, event.actor])).toEqual([[STALL, "owner"]]);
  });

  it("refuses a class the run holds no hold of, and records no event", async () => {
    const { w, runId } = await heldTwice();

    const envelope = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1, holdClass: "visual-gate2" });

    expect(envelope).toMatchObject({ ok: false, error: expect.stringContaining("no visual-gate2 hold") });
    expect(w.routes.shepherd!.store.get().eventsOf(runId)).toHaveLength(2);
  });
});

describe("a g10-adversary or owner-asked hold that only an owner-signed release lifts", () => {
  const ADVERSARY = "g10-adversary: trust rule";
  const OWNER = "owner-asked: hold, discuss";

  async function heldAs(reason: string, reviewer?: string): Promise<{ w: World; runId: string; store: ShepherdStore }> {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    await w.call("shepherd.hold", { repo: REPO, pr: 1, reason, actor: "seat-a", ...(reviewer && { reviewer }) });
    return { w, runId, store: w.routes.shepherd!.store.get() };
  }

  it.each([
    [ADVERSARY, "owner", undefined],
    [ADVERSARY, "seat-a", undefined],
    [ADVERSARY, undefined, undefined],
    [ADVERSARY, "owner", "g10-adversary"],
    [OWNER, "owner", undefined],
    [OWNER, "seat-a", undefined],
    [OWNER, undefined, undefined],
  ])("refuses shepherd.release of %s by actor %s (class %s) with exit 65, keeps the hold and records no release", async (reason, actor, holdClass) => {
    const { w, runId, store } = await heldAs(reason);

    const refused = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1, ...(actor && { actor }), ...(holdClass && { holdClass }) });

    expect(refused).toMatchObject({ ok: false, code: 65 });
    expect(store.heldReason(REPO, 1)).toBe(reason);
    expect(store.eventsOf(runId).map((event) => event.kind)).toEqual(["hold"]);
  });

  it("refuses an adversary release before reading the PR, naming the signed route", async () => {
    const { w } = await heldAs(ADVERSARY);
    w.fake.onGetPr = () => {
      throw new Error("github is down");
    };

    const refused = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1, actor: "owner" });

    expect(refused).toMatchObject({ ok: false, code: 65, error: expect.stringContaining("POST /holds/release-proof") });
  });

  it.each([
    ["another reviewer", "other-review"],
    ["no reviewer", undefined],
  ])("refuses a re-hold that moves the adversary hold to %s with exit 65 and writes nothing", async (_case, reviewer) => {
    const { w, runId, store } = await heldAs(ADVERSARY, "sec-review");

    const refused = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "g10-adversary: new detail", ...(reviewer && { reviewer }) });

    expect(refused).toMatchObject({ ok: false, code: 65, error: expect.stringContaining("reviewer sec-review") });
    expect(store.byRun(runId)).toMatchObject({ holdReason: ADVERSARY, holdReviewer: "sec-review" });
    expect(store.eventsOf(runId)).toHaveLength(1);
  });

  it("refuses a re-hold that names a reviewer for an adversary hold that waited on none", async () => {
    const { w, store } = await heldAs(ADVERSARY);

    const refused = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: ADVERSARY, reviewer: "friendly-review" });

    expect(refused).toMatchObject({ ok: false, code: 65 });
    expect(store.heldReason(REPO, 1)).toBe(ADVERSARY);
  });

  it("lets a re-hold change the adversary hold's detail under the same reviewer", async () => {
    const { w, runId } = await heldAs(ADVERSARY, "sec-review");

    const held = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "g10-adversary: new detail", reviewer: "sec-review" });

    expect(held).toEqual({ ok: true, data: { runId, held: { reason: "g10-adversary: new detail", reviewer: "sec-review" } } });
  });

  it("parks a hold of another class under the adversary hold, so releasing it leaves the adversary hold gating", async () => {
    const { w, runId } = await heldAs(ADVERSARY, "sec-review");

    const held = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "serve-down: y; TP-1" });
    const released = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1, holdClass: "serve-down" });

    expect(held).toMatchObject({ ok: true, data: { held: { reason: ADVERSARY, reviewer: "sec-review" } } });
    expect(released).toEqual({ ok: true, data: { runId, held: { reason: ADVERSARY, reviewer: "sec-review" } } });
  });

  it("still lifts the adversary hold by the compare-and-swap the signed route uses, recording its key", async () => {
    const { runId, store } = await heldAs(ADVERSARY);

    const lifted = store.releaseIfHeld(runId, ADVERSARY, { actor: "key:owner-mac", headSha: H1 });

    expect(lifted).toBe(true);
    expect(store.eventsOf(runId).at(-1)).toMatchObject({ kind: "release", actor: "key:owner-mac", headSha: H1 });
  });
});

describe("shepherd.hold reason classes", () => {
  const LEGACY = "seat merges by the interim procedure";
  const TYPED = "run-failed: land-rules refuses; TP-2";

  async function heldWorld(): Promise<{ w: World; runId: string; heldReason: () => string | null | undefined }> {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await registered(w, pr1);
    return { w, runId, heldReason: () => w.routes.shepherd!.store.get().byRun(runId)?.holdReason };
  }

  it.each([
    ["an untyped seat-path reason", LEGACY, "is not a hold class"],
    ["a defect class with no task ID", "serve-down: no answer for 60 minutes", "a serve-down hold names no task ID"],
  ])("refuses %s with exit 65 and leaves the run unheld", async (_case, reason, why) => {
    const { w, heldReason } = await heldWorld();

    const refused = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason });
    const merge = await w.call<MergeEvaluation>("shepherd.merge", { repo: REPO, pr: 1 });

    expect(refused).toMatchObject({ ok: false, code: 65, error: expect.stringContaining(why) });
    expect(refused).toMatchObject({ error: expect.stringContaining("serve-down, stalled, no-reviewer, run-failed, visual-gate2, g10-review, g10-adversary") });
    expect(heldReason()).toBeNull();
    expect(merge).toMatchObject({ ok: true, data: { held: null } });
  });

  it("a refused hold leaves an existing hold exactly as it was", async () => {
    const { w, runId, heldReason } = await heldWorld();
    w.routes.shepherd!.store.get().hold(runId, LEGACY);

    const refused = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "interim: bin/merge" });

    expect(refused).toMatchObject({ ok: false, code: 65 });
    expect(heldReason()).toBe(LEGACY);
  });

  it("releases a hold whose stored reason is untyped", async () => {
    const { w, runId, heldReason } = await heldWorld();
    w.routes.shepherd!.store.get().hold(runId, LEGACY);

    const released = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1 });

    expect(released).toEqual({ ok: true, data: { runId, held: null } });
    expect(heldReason()).toBeNull();
  });

  it("replaces an untyped stored hold with a typed one", async () => {
    const { w, runId, heldReason } = await heldWorld();
    w.routes.shepherd!.store.get().hold(runId, LEGACY);

    const replaced = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: TYPED });

    expect(replaced).toEqual({ ok: true, data: { runId, held: { reason: TYPED } } });
    expect(heldReason()).toBe(TYPED);
  });

  it("accepts a taskless gate class with no task ID", async () => {
    const { w, runId } = await heldWorld();

    const held = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "visual-gate2: owner sign-off quoted in the body" });

    expect(held).toEqual({ ok: true, data: { runId, held: { reason: "visual-gate2: owner sign-off quoted in the body" } } });
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
