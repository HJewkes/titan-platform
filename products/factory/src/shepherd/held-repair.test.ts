import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened, spaceUpdates } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { ShepherdPhases, Verdict, WakeOutcome, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";

const H2 = fakeSha("held-fix");
const HOLD = "visual-gate2: the owner reviews the contrast baseline";
const SEATED: EffectivePolicy = { ...OWNER_GATE_POLICY, seat: "demo-seat" };
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface Sent {
  seat: string;
  text: string;
}

function seatPorts(hubSeat?: string): { sent: Sent[]; ports: ExitNoticePorts } {
  const sent: Sent[] = [];
  const ports: ExitNoticePorts = {
    seatFor: () => "book-seat",
    ...(hubSeat !== undefined && { hubSeat: () => hubSeat }),
    lastReport: async () => undefined,
    send: async (seat, text) => void sent.push({ seat, text }),
  };
  return { sent, ports };
}

const merge = (headSha: string): Verdict => ({ kind: "MERGE", headSha, evidence: {} });

/** Every wake is recorded; a taken wake pushes H2, which CI and the reviewer pass. */
function phases(fake: FakeGitHub, wakes: WakeRequest[], firstVerdict: (headSha: string) => Verdict = merge): ShepherdPhases {
  return {
    wake: async (_ctx, request): Promise<WakeOutcome> => (wakes.push(request), fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }),
    review: async (_ctx, request) => (request.headSha === H1 ? firstVerdict(H1) : merge(request.headSha)),
  };
}

interface HeldWorld {
  host: FactoryHost;
  store: ShepherdStoreRef;
  runId: string;
}

function factoryHost(fake: FakeGitHub, ports: ExitNoticePorts, shepherd: ShepherdPhases, store: ShepherdStoreRef, dbPath = ":memory:"): FactoryHost {
  let clock = 0;
  spaceUpdates(fake, (ms) => void (clock += ms));
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice: ports, park: async () => ({ lines: [] }) });
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(shepherd)], routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

function heldWorld(fake: FakeGitHub, ports: ExitNoticePorts, shepherd: ShepherdPhases, policy: EffectivePolicy = SEATED, dbPath?: string): HeldWorld {
  const store = shepherdStoreRef();
  const host = factoryHost(fake, ports, shepherd, store, dbPath);
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
  store.get().hold(runId, HOLD);
  return { host, store, runId };
}

/** H1 is red on validate, every later head green. */
const redAtH1 = (fake: FakeGitHub) => (fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, pr.headSha === H1 ? "failure" : "success"), successRun("dag-check", 2)]));
const green = (fake: FakeGitHub) => (fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]));

async function waitingOnHold({ host, runId }: HeldWorld): Promise<void> {
  await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toMatch(/^sh-held-wait/));
}

describe("a held run whose head needs a fix wakes no agent and tells the seat once", () => {
  it("a red head: no repair wake, one seat notice naming the hold, the head and the failing checks", async () => {
    const fake = fakeGitHub();
    redAtH1(fake);
    const wakes: WakeRequest[] = [];
    const { sent, ports } = seatPorts();
    const world = heldWorld(fake, ports, phases(fake, wakes));

    await waitingOnHold(world);

    expect(wakes).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.seat).toBe("demo-seat");
    expect(sent[0]!.text).toContain(HOLD);
    expect(sent[0]!.text).toContain(`head ${H1}`);
    expect(sent[0]!.text).toContain("validate");
    expect(fake.pr(1).headSha).toBe(H1);
  });

  it("a FIX_FIRST verdict: no fixer wake, one seat notice naming the hold, the head and the verdict", async () => {
    const fake = fakeGitHub();
    green(fake);
    const wakes: WakeRequest[] = [];
    const { sent, ports } = seatPorts();
    const world = heldWorld(fake, ports, phases(fake, wakes, () => ({ kind: "FIX_FIRST", headSha: H1, text: "missing test" })));

    await waitingOnHold(world);

    expect(wakes).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.seat).toBe("demo-seat");
    expect(sent[0]!.text).toContain(HOLD);
    expect(sent[0]!.text).toContain(`head ${H1}`);
    expect(sent[0]!.text).toContain("FIX_FIRST");
  });

  it("a run whose policy names no seat tells the hub seat", async () => {
    const fake = fakeGitHub();
    redAtH1(fake);
    const wakes: WakeRequest[] = [];
    const { sent, ports } = seatPorts("hub-seat");
    const world = heldWorld(fake, ports, phases(fake, wakes), OWNER_GATE_POLICY);

    await waitingOnHold(world);

    expect(wakes).toEqual([]);
    expect(sent.map((notice) => notice.seat)).toEqual(["hub-seat"]);
  });

  it("on release the normal repair path resumes at the same head and the fix lands as before", async () => {
    const fake = fakeGitHub();
    redAtH1(fake);
    const wakes: WakeRequest[] = [];
    const { sent, ports } = seatPorts();
    const world = heldWorld(fake, ports, phases(fake, wakes));
    await waitingOnHold(world);

    world.store.get().release(world.runId);
    await gateOpened(world.host, gateId(world.runId, "approve-merge"));

    expect(wakes).toEqual([expect.objectContaining({ kind: "ci-red", headSha: H1 })]);
    expect(sent).toHaveLength(1);
    expect(world.host.gates.get(gateId(world.runId, "approve-merge"))?.prompt).toContain(`at head ${H2}`);
  });

});

/** The run reached review at H2 and then a merge decision or gate, the only places a held run can rest at H2. */
const settledAtH2 = ({ host, runId }: HeldWorld): boolean => /^(merge|sh-held-wait)(:|$)/.test(host.runtime.status(runId)?.currentStep ?? "") || host.pendingGates().length > 0;
const heldWaitResult = ({ host, runId }: HeldWorld): unknown => Object.values(host.runtime.status(runId)!.stepResults).find((result) => /^sh-held-wait/.test(result.stepId))?.data?.["result"];

describe("a head pushed while the run is held runs CI and review at it, with the hold kept", () => {
  const cases: Array<[string, (fake: FakeGitHub) => void, ((headSha: string) => Verdict) | undefined]> = [
    ["a ci-red", redAtH1, undefined],
    ["a FIX_FIRST", green, () => ({ kind: "FIX_FIRST", headSha: H1, text: "missing test" })],
  ];

  it.each(cases)("after %s wake: review at the pushed head, no wake, still held and unmerged", async (_wake, fixture, firstVerdict) => {
    const fake = fakeGitHub();
    fixture(fake);
    const wakes: WakeRequest[] = [];
    const reviewed: string[] = [];
    const shepherd = phases(fake, wakes, firstVerdict);
    const { ports } = seatPorts();
    const world = heldWorld(fake, ports, { ...shepherd, review: async (ctx, request) => (reviewed.push(request.headSha), shepherd.review(ctx, request)) });
    await waitingOnHold(world);
    const release = vi.spyOn(world.store.get(), "release");

    fake.pushHead(1, H2);
    await vi.waitFor(() => expect(reviewed).toContain(H2), { timeout: 5_000 });
    await vi.waitFor(() => expect(settledAtH2(world)).toBe(true), { timeout: 5_000 });

    expect(wakes).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(world.store.get().byRun(world.runId)).toMatchObject({ held: true, holdReason: HOLD });
    expect(fake.pr(1).merged).toBe(false);
  });

  it("the held wait records the head it moved to", async () => {
    const fake = fakeGitHub();
    redAtH1(fake);
    const { ports } = seatPorts();
    const world = heldWorld(fake, ports, phases(fake, []));
    await waitingOnHold(world);

    fake.pushHead(1, H2);
    await vi.waitFor(() => expect(heldWaitResult(world)).toBeDefined());

    expect(heldWaitResult(world)).toEqual({ moved: true, headSha: H2 });
  });

  it("the held wait records no head when the PR closes", async () => {
    const fake = fakeGitHub();
    redAtH1(fake);
    const { ports } = seatPorts();
    const world = heldWorld(fake, ports, phases(fake, []));
    await waitingOnHold(world);

    fake.pr(1).state = "closed";
    await vi.waitFor(() => expect(heldWaitResult(world)).toBeDefined());

    expect(heldWaitResult(world)).toEqual({ moved: true });
  });
});

/** H1 is red on validate until `rerun()` turns it green at the same head, as a rerun of the failed job does. */
function redThenGreenAtH1(fake: FakeGitHub): { rerun: () => void } {
  let rerunGreen = false;
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, pr.headSha === H1 && !rerunGreen ? "failure" : "success"), successRun("dag-check", 2)]);
  return { rerun: () => void (rerunGreen = true) };
}

const heldWaitResults = ({ host, runId }: HeldWorld): unknown[] =>
  Object.values(host.runtime.status(runId)!.stepResults)
    .filter((result) => /^sh-held-wait/.test(result.stepId))
    .map((result) => result.data?.["result"]);

const ticksPast = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a held ci-red wait also ends when the held head turns green, with the hold kept (TP-2523)", () => {
  it("a rerun turning H1 green: review at H1 and the merge gate at H1, no release, no wake, unmerged", async () => {
    const fake = fakeGitHub();
    const ci = redThenGreenAtH1(fake);
    const wakes: WakeRequest[] = [];
    const reviewed: string[] = [];
    const shepherd = phases(fake, wakes);
    const world = heldWorld(fake, seatPorts().ports, { ...shepherd, review: async (ctx, request) => (reviewed.push(request.headSha), shepherd.review(ctx, request)) });
    await waitingOnHold(world);
    const release = vi.spyOn(world.store.get(), "release");

    ci.rerun();
    await vi.waitFor(() => expect(reviewed).toContain(H1), { timeout: 5_000 });
    await gateOpened(world.host, gateId(world.runId, "approve-merge"));

    expect(heldWaitResult(world)).toEqual({ moved: false, green: true });
    expect(world.host.gates.get(gateId(world.runId, "approve-merge"))?.prompt).toContain(`at head ${H1}`);
    expect(wakes).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    expect(world.store.get().byRun(world.runId)).toMatchObject({ held: true, holdReason: HOLD });
    expect(fake.pr(1).merged).toBe(false);
  });

  it("a held FIX_FIRST wait at a green head does not end on green", async () => {
    const fake = fakeGitHub();
    green(fake);
    const reviewed: string[] = [];
    const shepherd = phases(fake, [], () => ({ kind: "FIX_FIRST", headSha: H1, text: "missing test" }));
    const world = heldWorld(fake, seatPorts().ports, { ...shepherd, review: async (ctx, request) => (reviewed.push(request.headSha), shepherd.review(ctx, request)) });
    await waitingOnHold(world);

    await ticksPast(300);

    expect(world.host.runtime.status(world.runId)?.currentStep).toMatch(/^sh-held-wait/);
    expect(reviewed).toEqual([H1]);
    expect(heldWaitResults(world)).toEqual([]);
  });

  it("a held head that stays red keeps waiting", async () => {
    const fake = fakeGitHub();
    redAtH1(fake);
    const world = heldWorld(fake, seatPorts().ports, phases(fake, []));
    await waitingOnHold(world);

    await ticksPast(300);

    expect(world.host.runtime.status(world.runId)?.currentStep).toMatch(/^sh-held-wait/);
    expect(heldWaitResults(world)).toEqual([]);
  });
});

const StoredStepResults = z.record(z.string(), z.object({ stepId: z.string() }).loose());

/** Rewrites a stored run's step results; `edit` sees and returns them in recording order. Returns the rewritten keys. */
function rewriteRecord(dbPath: string, runId: string, edit: (entries: Array<[string, { stepId: string }]>) => Array<[string, { stepId: string }]>): string[] {
  const db = openDatabase(dbPath);
  const row = z.object({ step_results: z.string() }).parse(db.prepare("SELECT step_results FROM workflow_run WHERE id = ?").get(runId));
  const entries = edit(Object.entries(StoredStepResults.parse(JSON.parse(row.step_results))));
  db.prepare("UPDATE workflow_run SET step_results = ? WHERE id = ?").run(JSON.stringify(Object.fromEntries(entries)), runId);
  db.close();
  return entries.map(([key]) => key);
}

/** The 10-10 restart burst: a replay that predates the replay guard ran the bare check live and recorded `{held:false}`. */
function backfilledMemo(key: string): [string, { stepId: string }] {
  return [key, { stepId: "sh-held-check", iteration: Number(key.split(":")[1]), agentId: null, signal: null, operation: "dispatch", completedAt: "2026-10-10T05:29:00.000Z", data: { result: { held: false } } } as { stepId: string }];
}

/** The record as the run-wide counter wrote it: every held check under the bare id, numbered in recording order. */
function bareHeldChecks(entries: Array<[string, { stepId: string }]>): Array<[string, { stepId: string }]> {
  let calls = 0;
  return entries.map(([key, result]) => (result.stepId.startsWith("sh-held-check:") ? [`sh-held-check:${calls}`, { ...result, stepId: "sh-held-check", iteration: calls++ }] : [key, result]));
}

const recordedKeys = (host: FactoryHost, runId: string): string[] => Object.keys(host.runtime.status(runId)!.stepResults);
const tempDb = (): string => join(mkdtempSync(join(tmpdir(), "tp2452-")), "factory.db");

describe("the held check is keyed by round and head, so a back-filled memo never answers a live wake (TP-2452)", () => {
  it("a held run whose record carries back-filled {held:false} memos parks under strict replay and wakes no fixer (TP-2574)", async () => {
    const dbPath = tempDb();
    const fake = fakeGitHub();
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, "failure"), successRun("dag-check", 2)]);
    const wakes: WakeRequest[] = [];
    const first = heldWorld(fake, seatPorts().ports, phases(fake, wakes), SEATED, dbPath);
    await waitingOnHold(first);
    first.host.close();
    rewriteRecord(dbPath, first.runId, (entries) => [...entries, ...["sh-held-check:1", "sh-held-check:2", "sh-held-check:3"].map(backfilledMemo)]);

    const second = factoryHost(fake, seatPorts().ports, phases(fake, wakes), first.store, dbPath);
    await second.adopt();
    const run = await second.runtime.wait(first.runId);

    expect(run.status).toBe("recovery_required");
    expect(run.error).toMatch(/replay diverged: .* next sh-held-check:1$/);
    expect(wakes).toEqual([]);
  });

  it("a record that went on with the bare check replays its route and records no keyed check", async () => {
    const dbPath = tempDb();
    const fake = fakeGitHub();
    redAtH1(fake);
    const wakes: WakeRequest[] = [];
    const store = shepherdStoreRef();
    const first = factoryHost(fake, seatPorts().ports, phases(fake, wakes), store, dbPath);
    fake.addPr({ headSha: H1 });
    const runId = first.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: SEATED });
    await gateOpened(first, gateId(runId, "approve-merge"));
    first.close();
    const legacyKeys = rewriteRecord(dbPath, runId, bareHeldChecks);

    const second = factoryHost(fake, seatPorts().ports, phases(fake, wakes), store, dbPath);
    await second.adopt();
    second.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H2 }, OWNER);
    await vi.waitFor(() => expect(fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(legacyKeys).toContain("sh-held-check:0");
    expect(recordedKeys(second, runId).slice(0, legacyKeys.length)).toEqual(legacyKeys);
    expect(recordedKeys(second, runId).filter((key) => key.startsWith("sh-held-check:r"))).toEqual([]);
  });
});
