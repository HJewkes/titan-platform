import { FileListTruncatedError, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { fakeLocator } from "../test-support/fakes.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import type { ExitNoticePorts } from "./ports.js";
import { MERGE_EVIDENCE_STEP } from "./merge-facts.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const MINUTE = 60_000;
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = fakeLocator({ sourceId: "transcript-1" });

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const phases: ShepherdPhases = {
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: (ctx, request: ReviewRequest) =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] }),
};

/** Whether the files read in evidence collection `collection` (the first is 1) throws, and with what; reads outside it never do. */
type FilesFault = (collection: number) => Error | undefined;

interface World {
  fake: FakeGitHub;
  host: FactoryHost;
  runId: string;
  clock: { now: number };
  notices: { seat: string; text: string }[];
  /** Evidence collections so far, the first one included. */
  collections: () => number;
}

function rateLimited(): Error {
  return Object.assign(new Error("API rate limit exceeded"), { status: 403 });
}

/** One clean, green PR whose changed-files read fails as `fault` says; a seat is told when `seat` is set. */
function world(fault: FilesFault, seat?: string): World {
  const fake = fakeGitHub();
  const clock = { now: 0 };
  const notices: { seat: string; text: string }[] = [];
  const exitNotice: ExitNoticePorts | undefined = seat === undefined ? undefined : { seatFor: () => seat, lastReport: async () => undefined, send: async (to, text) => void notices.push({ seat: to, text }) };
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const evidence = { collections: 0, collecting: false };
  const list = fake.wire.listPrFiles;
  fake.wire.listPrFiles = async (...args) => {
    const error = evidence.collecting ? fault(evidence.collections) : undefined;
    if (error) throw error;
    return list(...args);
  };
  const store = shepherdStoreRef();
  const base = factoryRoutesFor({
    port: githubPort(fake.wire),
    store,
    now: () => clock.now,
    sleep: async (ms: number, signal: AbortSignal) => ((clock.now += ms), sleep(1, signal)),
    park: async () => ({ lines: [] }),
    registry: async () => "trusted" as const,
    mergeTree: async () => "clean",
    ...(exitNotice && { exitNotice }),
  });
  const collect = (route: StepRoute): StepRoute => ({
    ...route,
    runner: {
      run: async (input) => {
        Object.assign(evidence, { collections: evidence.collections + 1, collecting: true });
        try {
          return await route.runner.run(input);
        } finally {
          evidence.collecting = false;
        }
      },
    },
  });
  const routes = Object.assign(base.map((route) => (route.match === MERGE_EVIDENCE_STEP ? collect(route) : route)), { database: base.database, shepherd: base.shepherd });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  return { fake, host, runId, clock, notices, collections: () => evidence.collections };
}

function runGates(w: World): unknown[] {
  return w.host.pendingGates().filter((pending) => pending.runId === w.runId);
}

describe("a MERGE whose changed-files read fails at the head", () => {
  it("a transient 403 on the changed-files read retries instead of parking an owner gate", async () => {
    const w = world((collection) => (collection <= 2 ? rateLimited() : undefined));

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true));

    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))).toBeUndefined();
    expect(w.collections()).toBe(3);
    expect(w.fake.effects.merge).toBe(1);
  });

  it("a changed-files read that keeps failing tells the seat once, opens no owner gate and never merges", async () => {
    const w = world(rateLimited, "trusted-seat");

    await vi.waitFor(() => expect(w.clock.now).toBeGreaterThanOrEqual(45 * MINUTE));

    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]!.seat).toBe("trusted-seat");
    expect(w.notices[0]!.text).toContain("the read failed: HTTP 403");
    expect(runGates(w)).toEqual([]);
    expect(w.fake.effects.merge).toBe(0);
  });

  it("a truncated changed-files list still asks the owner at once, with no re-read", async () => {
    const w = world(() => new FileListTruncatedError(3001, 3000), "trusted-seat");

    await gateOpened(w.host, gateId(w.runId, "approve-merge"));

    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))!.prompt).toContain("shepherd-merge-guard/files-unread");
    expect(w.notices).toEqual([]);
    expect(w.collections()).toBe(1);
    expect(w.fake.effects.merge).toBe(0);
  });
});
