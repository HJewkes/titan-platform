import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stepIdMatches } from "../definition.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { REPO, gateId, spaceUpdates } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { SHEPHERD_WORKFLOW } from "./commands.js";
import { supersedeMovedGates } from "./head-moved.js";
import type { ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { resyncShepherd } from "./resync.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";
import { watchRow } from "./view.js";

const H1 = fakeSha("held-merge-h1");
const H2 = fakeSha("held-merge-h2");
const HOLD = "g10-review: +415/-0 diff over 400";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const SEED_LEASE_MS = 3_000;
const AFTER_LEASE = T0 + 60_000;

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

interface Shepherd {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStoreRef;
  services: NonNullable<FactoryRoutes["shepherd"]>;
  reviewed: string[];
}

function mergingPhases(reviewed: string[]): ShepherdPhases {
  return {
    review: async (_ctx, request) => (reviewed.push(request.headSha), { kind: "MERGE", headSha: request.headSha, evidence: {} }),
    wake: async () => ({ kind: "unhandled", reason: "test" }),
  };
}

function greenFake(): FakeGitHub {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  return fake;
}

function routesFor(fake: FakeGitHub, now: () => number = () => 0): FactoryRoutes {
  return factoryRoutesFor({ port: githubPort(fake.wire), store: shepherdStoreRef(), now, sleep: async (_ms, signal) => sleep(1, signal) });
}

/** The merge step's runner never settles, the way a merge wait that died in a reboot leaves it active. */
function hangingAtMerge(routes: FactoryRoutes): FactoryRoutes {
  const hung: StepRoute[] = routes.map((route) => ({
    ...route,
    runner: { run: (input) => (stepIdMatches("merge", input.stepId) ? new Promise(() => undefined) : route.runner.run(input)) },
  }));
  return Object.assign(hung, { database: routes.database, shepherd: routes.shepherd });
}

function openHost(fake: FakeGitHub, reviewed: string[], routes: FactoryRoutes, options: { dbPath?: string; now?: () => number; leaseMs?: number } = {}): Shepherd {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(mergingPhases(reviewed))], routes, gatePollMs: 5, ...options });
  cleanups.push(() => host.close());
  return { host, fake, store: routes.shepherd!.store, services: routes.shepherd!, reviewed };
}

/** A run that walks a strict repo's whole update budget takes longer than the default wait. */
async function opened(host: FactoryHost, id: string): Promise<void> {
  await vi.waitFor(() => expect(host.gates.get(id)?.status).toBe("pending"), { timeout: 4_000 });
}

async function untilActive(host: FactoryHost, runId: string, stepId: string): Promise<void> {
  while (!Object.keys(host.runtime.status(runId)?.activeSteps ?? {}).some((key) => stepIdMatches(stepId, key))) await sleep(5, new AbortController().signal);
}

/** An owner-gated run on PR 1, held for a g10 review, whose owner approved H1: its merge step is waiting on the hold. */
async function heldAtMerge(shepherd: Shepherd): Promise<string> {
  const { host, fake, store } = shepherd;
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.get().hold(runId, HOLD);
  await opened(host, gateId(runId, "approve-merge"));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  await untilActive(host, runId, "merge");
  return runId;
}

function headOf(shepherd: Shepherd, runId: string): string | null {
  return watchRow({ registration: shepherd.store.get().byRun(runId)!, run: shepherd.host.runtime.status(runId)! }).headSha;
}

/** No merge PUT reached GitHub, and the hold still stands with its own reason. */
function expectHeldUnmerged(shepherd: Shepherd, runId: string): void {
  expect(shepherd.fake.calls).not.toContain("merge");
  expect(shepherd.fake.pr(1).merged).toBe(false);
  expect(shepherd.store.get().byRun(runId)).toMatchObject({ held: true, holdReason: HOLD });
}

describe("a run held at its merge step whose pull request head moves", () => {
  it("leaves merging, takes CI and review at the new head, and meets the same hold there with no merge at the old head", async () => {
    const fake = greenFake();
    const shepherd = openHost(fake, [], routesFor(fake));
    const runId = await heldAtMerge(shepherd);

    fake.pushHead(1, H2);

    await opened(shepherd.host, gateId(runId, "approve-merge", 1));
    expect(shepherd.host.gates.get(gateId(runId, "approve-merge", 1))?.prompt).toContain(`at head ${H2}`);
    expect(shepherd.reviewed).toEqual([H1, H2]);
    shepherd.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H2 }, OWNER);
    await untilActive(shepherd.host, runId, "merge:1");
    expect(headOf(shepherd, runId)).toBe(H2);
    expectHeldUnmerged(shepherd, runId);
  });
});

describe("shepherd resync on a held merge step of a run no runtime holds", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** The seed host went down mid-wait: its clock is frozen and it never releases the run's lease. */
  async function seededHeld(): Promise<{ fake: FakeGitHub; dbPath: string; runId: string }> {
    const dir = mkdtempSync(join(tmpdir(), "factory-held-merge-"));
    dirs.push(dir);
    const dbPath = join(dir, "factory.sqlite3");
    const fake = greenFake();
    const seed = openHost(fake, [], hangingAtMerge(routesFor(fake)), { dbPath, now: () => T0, leaseMs: SEED_LEASE_MS });
    return { fake, dbPath, runId: await heldAtMerge(seed) };
  }

  function restarted(fake: FakeGitHub, dbPath: string): Shepherd {
    return openHost(fake, [], routesFor(fake), { dbPath, now: () => AFTER_LEASE });
  }

  const activeIn = (shepherd: Shepherd, runId: string) => Object.keys(shepherd.host.runtime.status(runId)!.activeSteps);

  it("answers the merge step with no merge, and the adopted run reviews the new head and meets the same hold there", async () => {
    const { fake, dbPath, runId } = await seededHeld();
    fake.pushHead(1, H2);
    const shepherd = restarted(fake, dbPath);

    const report = await resyncShepherd(shepherd.host, shepherd.services);

    expect(report.supersededMerges).toEqual([{ runId, stepId: "merge:0", from: H1, to: H2 }]);
    expect(activeIn(shepherd, runId)).toEqual([]);
    await shepherd.host.adopt();
    await opened(shepherd.host, gateId(runId, "approve-merge", 1));
    expect(shepherd.host.gates.get(gateId(runId, "approve-merge", 1))?.prompt).toContain(`at head ${H2}`);
    expect(shepherd.reviewed.at(-1)).toBe(H2);
    expect(headOf(shepherd, runId)).toBe(H2);
    expectHeldUnmerged(shepherd, runId);
  });

  it("a dry run reports the moved merge step and leaves it active", async () => {
    const { fake, dbPath, runId } = await seededHeld();
    fake.pushHead(1, H2);
    const shepherd = restarted(fake, dbPath);

    const report = await resyncShepherd(shepherd.host, shepherd.services, { dryRun: true });

    expect(report.supersededMerges).toEqual([{ runId, stepId: "merge:0", from: H1, to: H2 }]);
    expect(activeIn(shepherd, runId)).toEqual(["merge:0"]);
    expect(headOf(shepherd, runId)).toBe(H1);
  });

  it("leaves the merge step alone while the head it waits at is still the pull request's head", async () => {
    const { fake, dbPath, runId } = await seededHeld();
    const shepherd = restarted(fake, dbPath);

    const report = await resyncShepherd(shepherd.host, shepherd.services);

    expect(report.supersededMerges).toEqual([]);
    expect(activeIn(shepherd, runId)).toEqual(["merge:0"]);
    expectHeldUnmerged(shepherd, runId);
  });
});

describe("a pending stuck-behind gate whose pull request head moved", () => {
  /** A strict repo whose base moves past every head but H2, so the run spends its update budget and asks the owner. */
  async function stuckBehind(): Promise<{ shepherd: Shepherd; runId: string; gated: string }> {
    const fake = greenFake();
    const green = fake.onGetPr!;
    fake.onGetPr = (pr, reads) => (green(pr, reads), (pr.behind = pr.headSha !== H2));
    let clock = 0;
    spaceUpdates(fake, (ms) => void (clock += ms));
    const shepherd = openHost(fake, [], routesFor(fake, () => clock));
    fake.addPr({ headSha: H1 });
    const runId = shepherd.host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    shepherd.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    await opened(shepherd.host, gateId(runId, "stuck-behind"));
    return { shepherd, runId, gated: fake.pr(1).headSha };
  }

  it("is superseded once the implementer pushes, and the new head goes on to the merge decision", async () => {
    const { shepherd, runId, gated } = await stuckBehind();
    shepherd.fake.pushHead(1, H2);

    const superseded = await supersedeMovedGates(shepherd.host, shepherd.services);

    expect(superseded).toEqual([{ runId, gateId: gateId(runId, "stuck-behind"), from: gated, to: H2, condition: "head-moved" }]);
    expect(shepherd.host.gates.get(gateId(runId, "stuck-behind"))?.status).toBe("cancelled");
    await opened(shepherd.host, gateId(runId, "approve-merge"));
    expect(shepherd.host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`at head ${H2}`);
    expect(shepherd.host.runtime.status(runId)?.status).not.toBe("failed");
  });

  it("stays with the owner while the gated head is still the pull request's head", async () => {
    const { shepherd, runId } = await stuckBehind();

    expect(await supersedeMovedGates(shepherd.host, shepherd.services, { dryRun: true })).toEqual([]);
    expect(await supersedeMovedGates(shepherd.host, shepherd.services)).toEqual([]);
    expect(shepherd.host.gates.get(gateId(runId, "stuck-behind"))?.status).toBe("pending");
  });
});
