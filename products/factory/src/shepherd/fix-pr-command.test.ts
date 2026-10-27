import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { H1, REPO, gateId } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { codeRoute, sleep } from "../workflows/land.js";
import { eventsSince } from "./events.js";
import { fixPrCommand } from "./fix-pr-command.js";
import { formatShepherd } from "./format.js";
import { freezeGuard, freezeStoreRef, recheckedFrozen } from "./freeze.js";
import { MERGE_EVIDENCE_STEP, mergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { repoFreezeCommand } from "./repo-freeze-command.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef } from "./store.js";
import { timelineEntries } from "./view.js";

const RED_SHA = fakeSha("fix-pr-red");
const SEAT = "demo-seat";
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: SEAT };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Two open PRs on REPO, both green and clean; `phases` drives any run a test starts. */
function world(phases?: ShepherdPhases) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    pr.mergeableState = "clean";
  };
  const port = githubPort(fake.wire);
  const clock = { now: 0 };
  const store = shepherdStoreRef();
  const freeze = freezeStoreRef(() => clock.now);
  const tick = async (ms: number, signal: AbortSignal) => ((clock.now += ms), sleep(1, signal));
  const base = factoryRoutesFor({ port, store, freeze, now: () => clock.now, sleep: tick, park: async () => ({ lines: [] }), registry: async () => "trusted" as const, mergeTree: async () => "clean" });
  const isFrozen = recheckedFrozen(port, () => freeze.get(), () => store.get(), () => clock.now);
  const evidence = codeRoute(MERGE_EVIDENCE_STEP, () => clock.now, async (input: MergeEvidenceInput) => mergeEvidence(port, input, () => isFrozen(input.repo, input.pr), {}, { sleep: async () => undefined }));
  const routes = Object.assign(base.map((route) => (route.match === MERGE_EVIDENCE_STEP ? evidence : route)), { database: base.database, shepherd: base.shepherd });
  fake.addPr({ headSha: H1, mergeSha: fakeSha("fix-pr-merge-1") });
  fake.addPr({ headSha: fakeSha("fix-pr-head-2"), mergeSha: fakeSha("fix-pr-merge-2") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const ctx = partialFake<FactoryContext>({ host, shepherd: routes.shepherd! });
  return { fake, port, host, store, ctx, freezes: () => freeze.get() };
}

type World = ReturnType<typeof world>;

const registerPr = (w: World, pr: number, runId = `run-${pr}`) => w.store.get().register({ repo: REPO, pr, runId, task: `demo/T-${pr}`, implementer: `impl-${pr}`, policy: AUTO });

const markFix = (w: World, args: { pr: number; episode?: number }) => fixPrCommand.run(fixPrCommand.args.parse({ repo: REPO, actor: SEAT, ...args }), w.ctx);

const guardReason = (w: World, pr: number) => freezeGuard({ freezes: w.freezes, registrations: () => w.store.get() }).reason(w.port, REPO, pr, "main");

describe("shepherd fix-pr", () => {
  it("lets the marked fix PR through the freeze guard while another registered PR stays held", async () => {
    const w = world();
    w.freezes().freeze(REPO, RED_SHA);
    registerPr(w, 1);
    registerPr(w, 2);

    const result = await markFix(w, { pr: 1 });

    expect(result).toMatchObject({ repo: REPO, pr: 1, episode: 1, redSha: RED_SHA, marked: true, actor: SEAT });
    expect(await guardReason(w, 1)).toBeUndefined();
    expect(await guardReason(w, 2)).toContain("is frozen: main is red");
    expect(w.freezes().isFrozen(REPO)).toBe(true);
  });

  it("refuses a repo with no open main-red freeze", async () => {
    const w = world();
    registerPr(w, 1);

    await expect(markFix(w, { pr: 1 })).rejects.toMatchObject({ code: EXIT.DATAERR, message: expect.stringContaining("has no open main-red freeze") });
  });

  it("refuses a PR that is not registered with shepherd, and marks nothing", async () => {
    const w = world();
    w.freezes().freeze(REPO, RED_SHA);

    await expect(markFix(w, { pr: 1 })).rejects.toMatchObject({ code: EXIT.DATAERR, message: expect.stringContaining("is not registered with shepherd") });
    expect(w.freezes().get(REPO)?.fixPr).toBeNull();
  });

  it("refuses an --episode that is not the open one, and a second PR once one is marked", async () => {
    const w = world();
    w.freezes().freeze(REPO, RED_SHA);
    registerPr(w, 1);
    registerPr(w, 2);

    await expect(markFix(w, { pr: 1, episode: 7 })).rejects.toMatchObject({ code: EXIT.DATAERR, message: expect.stringContaining("open main-red episode is 1, not 7") });
    await markFix(w, { pr: 1, episode: 1 });
    await expect(markFix(w, { pr: 2 })).rejects.toMatchObject({ message: expect.stringContaining("already has fix PR #1") });
    expect(await markFix(w, { pr: 1 })).toMatchObject({ marked: false });
  });

  it("shows the mark in shepherd freezes and in the marked PR's timeline, naming who marked it", async () => {
    const w = world();
    w.freezes().freeze(REPO, RED_SHA);
    registerPr(w, 1);

    await markFix(w, { pr: 1 });
    const freezes = await repoFreezeCommand.run({ action: "list" }, w.ctx);

    expect(freezes.mainRed).toEqual([expect.objectContaining({ repo: REPO, episode: 1, fixPr: 1, fixPrActor: SEAT })]);
    expect(formatShepherd("shepherd.freeze", freezes)).toContain(`fix PR #1 (by ${SEAT})`);
    expect(eventsSince(w.host.db).filter((event) => event.runId === "run-1")).toEqual([expect.objectContaining({ kind: "freeze", pr: 1, actor: SEAT, reason: "fix PR #1 marked" })]);
  });
});

const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };

/** A reviewer MERGE at the head with the seat's merge grant, so only the freeze stands between the run and its merge. */
const mergePhases: ShepherdPhases = {
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: (ctx, request: ReviewRequest) =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator: partialFake({}) }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] }),
};

describe("a run waiting on repo-not-frozen when its PR is marked as the fix", () => {
  it("merges on a later step with no re-register, while the repo stays frozen", async () => {
    const w = world(mergePhases);
    w.freezes().freeze(REPO, RED_SHA);
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
    registerPr(w, 1, runId);
    await vi.waitFor(() => expect(Object.keys(w.host.runtime.status(runId)!.stepResults).some((key) => key.startsWith("merge-settle"))).toBe(true));
    expect(w.fake.pr(1).merged).toBe(false);

    await markFix(w, { pr: 1 });

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 15_000 });
    expect(w.freezes().isFrozen(REPO)).toBe(true);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(timelineEntries(w.host.runtime.status(runId)!, [], w.store.get().eventsOf(runId))).toContainEqual(expect.objectContaining({ kind: "event", event: "freeze", reason: "fix PR #1 marked" }));
  }, 20_000);
});
