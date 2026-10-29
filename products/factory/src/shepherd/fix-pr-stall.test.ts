import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { codeRoute, sleep } from "../workflows/land.js";
import { THAW_STALL_ROUNDS } from "../workflows/land-settle.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { freezeStoreRef, recheckedFrozen } from "./freeze.js";
import { MERGE_EVIDENCE_STEP, mergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const RED_SHA = fakeSha("stall-red");
const SEAT = "demo-seat";
const FIX_TASK = "demo/T-fix";
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: SEAT };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A reviewer MERGE at the head with the seat's merge grant, so only the freeze stands between the run and its merge. */
const mergePhases: ShepherdPhases = {
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: (ctx, request: ReviewRequest) =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator: partialFake({}) }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] }),
};

/** One green, clean PR on a repo frozen red at RED_SHA, whose episode has FIX_TASK and a fixer other than the PR's implementer. */
function world() {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1)]);
    pr.mergeableState = "clean";
  };
  const port = githubPort(fake.wire);
  const clock = { now: 0 };
  const store = shepherdStoreRef();
  const freeze = freezeStoreRef(() => clock.now);
  const notices: { seat: string; text: string }[] = [];
  const exitNotice: ExitNoticePorts = { seatFor: () => SEAT, lastReport: async () => undefined, send: async (to, text) => void notices.push({ seat: to, text }) };
  const tick = async (ms: number, signal: AbortSignal) => ((clock.now += ms), sleep(1, signal));
  const base = factoryRoutesFor({ port, store, freeze, exitNotice, now: () => clock.now, sleep: tick, park: async () => ({ lines: [] }), registry: async () => "trusted" as const, mergeTree: async () => "clean" });
  const isFrozen = recheckedFrozen(port, () => freeze.get(), () => store.get(), () => clock.now);
  const evidence = codeRoute(MERGE_EVIDENCE_STEP, () => clock.now, async (input: MergeEvidenceInput) => mergeEvidence(port, input, () => isFrozen(input.repo, input.pr), {}, { sleep: async () => undefined }));
  const routes = Object.assign(base.map((route) => (route.match === MERGE_EVIDENCE_STEP ? evidence : route)), { database: base.database, shepherd: base.shepherd });
  fake.addPr({ headSha: H1, mergeSha: fakeSha("stall-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(mergePhases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const freezes = freeze.get();
  freezes.freeze(REPO, RED_SHA);
  freezes.setFixTask(REPO, 1, FIX_TASK);
  freezes.setFixer(REPO, 1, "fix-widget-other");
  return { fake, host, store, notices };
}

type World = ReturnType<typeof world>;

function start(w: World, task: string): string {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  w.store.get().register({ repo: REPO, pr: 1, runId, task, implementer: "impl-1", policy: AUTO });
  return runId;
}

const settles = (w: World, runId: string) => Object.keys(w.host.runtime.status(runId)!.stepResults).filter((key) => key.startsWith("merge-settle")).length;

describe("a thaw wait on a frozen fix-task PR", () => {
  it("a fix-task PR frozen without fix_pr gets one notice with the fix-pr command", async () => {
    const w = world();
    const runId = start(w, FIX_TASK);

    await vi.waitFor(() => expect(settles(w, runId)).toBeGreaterThan(THAW_STALL_ROUNDS + 3), { timeout: 15_000 });

    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]!.seat).toBe(SEAT);
    expect(w.notices[0]!.text).toContain(`titan-factory shepherd fix-pr ${REPO} 1 --episode 1`);
    expect(w.notices[0]!.text).toContain("fix-widget-other, not impl-1");
    expect(w.fake.pr(1).merged).toBe(false);
  }, 20_000);

  it("tells the seat nothing when the frozen PR is registered on another task", async () => {
    const w = world();
    const runId = start(w, "demo/T-other");

    await vi.waitFor(() => expect(settles(w, runId)).toBeGreaterThan(THAW_STALL_ROUNDS + 3), { timeout: 15_000 });

    expect(w.notices).toEqual([]);
    expect(w.fake.pr(1).merged).toBe(false);
  }, 20_000);
});
