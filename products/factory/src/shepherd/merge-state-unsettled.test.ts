import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { MERGE_EVIDENCE_STEP } from "./merge-facts.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";

const H2 = fakeSha("unsettled-head2");
const MINUTE = 60_000;
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = { sourceId: "transcript-1" } as unknown as SourceTextLocator;

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const phases: ShepherdPhases = {
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: (ctx, request: ReviewRequest) =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] }),
};

/** What GitHub answers the evidence step's reads with, by head and by how many collections that head has had. */
type EvidenceState = (headSha: string, collection: number, now: number) => string;

interface World {
  fake: FakeGitHub;
  routes: FactoryRoutes;
  store: ShepherdStoreRef;
  clock: { now: number };
  /** Evidence collections per head, the first one included. */
  collections: Map<string, number>;
  mergeTreeProbes: string[];
}

/**
 * ci-wait reads a settled clean PR, while the evidence step reads whatever `evidenceState` says: GitHub flips to
 * `unknown` when it recomputes the test merge after the base moves, which is what the evidence read keeps hitting.
 */
function world(evidenceState: EvidenceState): World {
  const fake = fakeGitHub();
  const clock = { now: 0 };
  const collections = new Map<string, number>();
  const mergeTreeProbes: string[] = [];
  let collecting: string | undefined;
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    pr.mergeableState = collecting === undefined ? "clean" : evidenceState(pr.headSha, collections.get(collecting) ?? 0, clock.now);
  };
  const tick = async (ms: number, signal: AbortSignal) => ((clock.now += ms), sleep(1, signal));
  const store = shepherdStoreRef();
  const base = factoryRoutesFor({
    port: githubPort(fake.wire),
    store,
    now: () => clock.now,
    sleep: tick,
    park: () => ({ lines: [] }),
    registry: async () => true,
    mergeTree: async (input) => (mergeTreeProbes.push(input.headSha), "clean"),
  });
  const counted = (route: StepRoute): StepRoute => ({
    ...route,
    runner: {
      run: async (input) => {
        const head = input.stepId.slice(MERGE_EVIDENCE_STEP.length + 1).split(":")[0]!;
        collections.set(head, (collections.get(head) ?? 0) + 1);
        collecting = head;
        try {
          return await route.runner.run(input);
        } finally {
          collecting = undefined;
        }
      },
    },
  });
  const routes = Object.assign(
    base.map((route) => (route.match === MERGE_EVIDENCE_STEP ? counted(route) : route)),
    { database: base.database, shepherd: base.shepherd },
  );
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  return { fake, routes, store, clock, collections, mergeTreeProbes };
}

function open(w: World, dbPath = ":memory:"): FactoryHost {
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(phases)], routes: w.routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

function start(host: FactoryHost, w: World): string {
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  w.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  return runId;
}

function settleRecords(host: FactoryHost, runId: string): { headSha: string; since: number; at: number; spent: boolean }[] {
  const results = Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId.startsWith("merge-settle"));
  return results.map((result) => (result.data as { result: { headSha: string; since: number; at: number; spent: boolean } }).result);
}

describe("a MERGE whose evidence reads mergeable_state unknown on every read", () => {
  it("re-polls instead of gating, and merges with no gate once GitHub settles after ten unknown collections", async () => {
    const w = world((_head, collection) => (collection <= 10 ? "unknown" : "clean"));
    const host = open(w);
    const runId = start(host, w);

    await host.runtime.wait(runId);

    expect(host.runtime.status(runId)?.status).toBe("completed");
    expect(w.fake.pr(1)).toMatchObject({ merged: true, headSha: H1 });
    expect(w.collections.get(H1)).toBe(11);
    expect(host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(host.gates.listPending()).toEqual([]);
    expect(w.mergeTreeProbes).toEqual([]);
  });

  it("gates once the bound expires, naming the elapsed time and the local merge-tree result", async () => {
    const w = world(() => "unknown");
    const host = open(w);
    const runId = start(host, w);

    await gateOpened(host, gateId(runId, "approve-merge"));

    const prompt = host.gates.get(gateId(runId, "approve-merge"))!.prompt;
    expect(prompt).toContain("shepherd-merge-guard/merge-state-unsettled");
    expect(prompt).toMatch(/unsettled for (3\d) min/);
    expect(prompt).toContain("local merge-tree: clean");
    expect(w.mergeTreeProbes).toEqual([H1]);
    expect(w.clock.now).toBeGreaterThanOrEqual(30 * MINUTE);
    const settles = settleRecords(host, runId);
    expect(settles.at(-1)).toMatchObject({ headSha: H1, spent: true });
    expect(new Set(settles.map((settle) => settle.since)).size).toBe(1);
    expect(w.fake.effects.merge).toBe(0);
  });

  it("gates at once with no re-poll when the evidence reads a blocking state", async () => {
    const w = world(() => "blocked");
    const host = open(w);
    const runId = start(host, w);

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(settleRecords(host, runId)).toEqual([]);
    expect(w.collections.get(H1)).toBe(1);
  });

  it("restarts the wait at a head pushed during it, so the new head gets its own bound", async () => {
    const w = world((head, _collection, now) => (head === H1 || now < 45 * MINUTE ? "unknown" : "clean"));
    const host = open(w);
    const runId = start(host, w);
    await vi.waitFor(() => expect(w.clock.now).toBeGreaterThanOrEqual(20 * MINUTE));
    w.fake.pushHead(1, H2);

    await host.runtime.wait(runId);

    expect(w.fake.pr(1)).toMatchObject({ merged: true, headSha: H2 });
    expect(host.gates.listPending()).toEqual([]);
    const sinceAt = (head: string) => new Set(settleRecords(host, runId).filter((settle) => settle.headSha === head).map((settle) => settle.since));
    expect(sinceAt(H1).size).toBe(1);
    expect(sinceAt(H2).size).toBe(1);
    expect([...sinceAt(H2)][0]).toBeGreaterThan([...sinceAt(H1)][0]!);
  });

  it("keeps the first-unknown time across a restart, so a replayed run does not start its bound over", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp1773-")), "factory.db");
    const w = world(() => "unknown");
    const first = open(w, dbPath);
    const runId = start(first, w);
    await vi.waitFor(() => expect(settleRecords(first, runId).length).toBeGreaterThanOrEqual(3));
    first.close();
    hosts.splice(hosts.indexOf(first), 1);
    const second = open(w, dbPath);
    const since = settleRecords(second, runId)[0]!.since;

    await second.adopt();
    await gateOpened(second, gateId(runId, "approve-merge"));

    expect(new Set(settleRecords(second, runId).map((settle) => settle.since))).toEqual(new Set([since]));
    expect(second.gates.get(gateId(runId, "approve-merge"))!.prompt).toMatch(/unsettled for 3\d min/);
  });
});
