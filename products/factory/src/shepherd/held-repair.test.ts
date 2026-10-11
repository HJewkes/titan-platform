import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened, spaceUpdates } from "../test-support/land.js";
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

function heldWorld(fake: FakeGitHub, ports: ExitNoticePorts, shepherd: ShepherdPhases, policy: EffectivePolicy = SEATED): HeldWorld {
  let clock = 0;
  spaceUpdates(fake, (ms) => void (clock += ms));
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice: ports, park: () => ({ lines: [] }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(shepherd)], routes, gatePollMs: 5 });
  hosts.push(host);
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
});
