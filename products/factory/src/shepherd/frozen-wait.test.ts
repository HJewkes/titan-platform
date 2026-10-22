import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { codeRoute, sleep } from "../workflows/land.js";
import { SettleResult } from "../workflows/land-settle.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { isFrozenOnlyGate, isNoFactsGate } from "./freeze-wait.js";
import { MERGE_EVIDENCE_STEP, mergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { ReviewRequest, ShepherdPhases, Verdict } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";

const HOUR = 60 * 60_000;
const SEAT = "trusted-seat";
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: SEAT };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = partialFake<SourceTextLocator>({});
const GRANTED = ["merge-on-green-approve"];

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A reviewer MERGE at the head, through the evidence step, with the seat grants given. */
function mergePhases(seatGrants: string[] = GRANTED): ShepherdPhases {
  return {
    wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
    review: (ctx, request: ReviewRequest) =>
      mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants }),
  };
}

/** A MERGE whose evidence never reached the verdict, so the policy finds no merge facts at the head. */
const noFactsPhases: ShepherdPhases = {
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: async (_ctx, request: ReviewRequest): Promise<Verdict> => ({ kind: "MERGE", headSha: request.headSha, evidence: null }),
};

interface World {
  fake: FakeGitHub;
  routes: FactoryRoutes;
  store: ShepherdStoreRef;
  clock: { now: number };
  /** Evidence collections, the first one included. */
  collections: { count: number };
  notices: { seat: string; text: string }[];
}

/** The repo reads frozen while `frozen(now)` holds; every other fact is clean and green. */
function world(frozen: (now: number) => boolean, seat?: string): World {
  const fake = fakeGitHub();
  const clock = { now: 0 };
  const collections = { count: 0 };
  const notices: { seat: string; text: string }[] = [];
  const exitNotice: ExitNoticePorts | undefined = seat === undefined ? undefined : { seatFor: () => seat, lastReport: async () => undefined, send: async (to, text) => void notices.push({ seat: to, text }) };
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    pr.mergeableState = "clean";
  };
  const port = githubPort(fake.wire);
  const store = shepherdStoreRef();
  const tick = async (ms: number, signal: AbortSignal) => ((clock.now += ms), sleep(1, signal));
  const base = factoryRoutesFor({ port, store, now: () => clock.now, sleep: tick, park: async () => ({ lines: [] }), registry: async () => "trusted" as const, mergeTree: async () => "clean", ...(exitNotice && { exitNotice }) });
  const evidence = codeRoute(MERGE_EVIDENCE_STEP, () => clock.now, async (input: MergeEvidenceInput) => {
    collections.count += 1;
    return mergeEvidence(port, input, async () => frozen(clock.now), {}, { sleep: async () => undefined });
  });
  const routes = Object.assign(
    base.map((route) => (route.match === MERGE_EVIDENCE_STEP ? evidence : route)),
    { database: base.database, shepherd: base.shepherd },
  );
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  return { fake, routes, store, clock, collections, notices };
}

function open(w: World, phases: ShepherdPhases): FactoryHost {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes: w.routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

function start(host: FactoryHost, w: World): string {
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  w.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  return runId;
}

function stepCount(host: FactoryHost, runId: string, prefix: string): number {
  return Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId.startsWith(prefix)).length;
}

function settleRecords(host: FactoryHost, runId: string): { spent: boolean }[] {
  const results = Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId.startsWith("merge-settle"));
  return results.map((result) => z.object({ result: SettleResult }).parse(result.data).result);
}

const gate = (table: string, rowId: string, reason: string) => ({ outcome: "gate" as const, rule: { table, rowId, version: 1 }, reason });

describe("which gates wait at their head", () => {
  it("reads an MRG-AU gate whose only unmet MRG-AU-RV condition is repo-not-frozen as frozen-only", () => {
    const reason = "MRG-AU-OW gates merge by automation:titan-factory; MRG-AU-RV unmet: repo-not-frozen; MRG-AU-RC unmet: carry-tree-equal, repo-not-frozen";

    expect(isFrozenOnlyGate(gate("authority", "MRG-AU-OW", reason))).toBe(true);
  });

  it("does not read a freeze beside another unmet MRG-AU-RV condition as frozen-only", () => {
    const reason = "MRG-AU-OW gates merge by automation:titan-factory; MRG-AU-RV unmet: seat-grants-merge-on-green-approve, repo-not-frozen";

    expect(isFrozenOnlyGate(gate("authority", "MRG-AU-OW", reason))).toBe(false);
  });

  it("reads only the merge guard's no-facts row as missing facts", () => {
    expect(isNoFactsGate(gate("shepherd-merge-guard", "no-facts", "no merge facts were collected at abc"))).toBe(true);
    expect(isNoFactsGate(gate("shepherd-merge-guard", "head-mismatch", "merge facts were collected at abc, not def"))).toBe(false);
  });
});

describe("a MERGE at a head whose repo is frozen", () => {
  it("waits out a two-hour freeze with no gate and no notice, and merges after the thaw with zero hitl rows", async () => {
    const w = world((now) => now < 2 * HOUR, SEAT);
    const host = open(w, mergePhases());
    const runId = start(host, w);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 15_000 });

    expect(w.fake.pr(1)).toMatchObject({ merged: true, headSha: H1 });
    expect(w.clock.now).toBeGreaterThanOrEqual(2 * HOUR);
    expect(host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(host.gates.listPending().filter((pending) => pending.id.startsWith(`${runId}/`))).toEqual([]);
    expect(w.notices).toEqual([]);
    expect(w.collections.count).toBeGreaterThan(1);
    expect(settleRecords(host, runId).every((settle) => settle.spent)).toBe(true);
  }, 20_000);

  it("still asks the owner at once when MRG-AU-RV also misses the seat grant", async () => {
    const w = world(() => true, SEAT);
    const host = open(w, mergePhases([]));
    const runId = start(host, w);

    await gateOpened(host, gateId(runId, "approve-merge"), 10_000);

    expect(host.gates.get(gateId(runId, "approve-merge"))!.prompt).toContain("repo-not-frozen");
    expect(stepCount(host, runId, "merge-settle")).toBe(0);
    expect(w.fake.effects.merge).toBe(0);
  });
});

describe("a MERGE whose merge facts are missing at the head", () => {
  it("re-reads once at the head, then tells the seat and opens no approve-merge", async () => {
    const w = world(() => false, SEAT);
    const host = open(w, noFactsPhases);
    const runId = start(host, w);

    await vi.waitFor(() => expect(w.notices).toHaveLength(1), { timeout: 10_000 });

    expect(settleRecords(host, runId).slice(0, 2)).toEqual([expect.objectContaining({ spent: false }), expect.objectContaining({ spent: true })]);
    expect(w.notices[0]!.seat).toBe(SEAT);
    expect(w.notices[0]!.text).toContain(`no merge facts were collected at ${H1}`);
    expect(w.notices[0]!.text).toContain("still so after one re-read");
    expect(host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(w.fake.effects.merge).toBe(0);
  });

  it("asks the owner after the one re-read when no seat notice is wired", async () => {
    const w = world(() => false);
    const host = open(w, noFactsPhases);
    const runId = start(host, w);

    await gateOpened(host, gateId(runId, "approve-merge"), 10_000);

    expect(stepCount(host, runId, "merge-policy")).toBe(2);
    expect(host.gates.get(gateId(runId, "approve-merge"))!.prompt).toContain("still so after one re-read");
  });
});
