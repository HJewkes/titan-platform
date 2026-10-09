import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened, spaceUpdates } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { ShepherdPhases, Verdict, WakeOutcome } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const H2 = fakeSha("head2");
const GONE = "no agent of impl-a's lineage is on the roster, so no checkout is known to start a successor in";
const SEAT_GATES = ["ci-failed", "sh-sent-back", "stuck-behind"] as const;
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface Seat {
  sends: string[];
  ports: ExitNoticePorts;
}

function seat(fails = false): Seat {
  const sends: string[] = [];
  const ports: ExitNoticePorts = {
    seatFor: () => "demo-coord",
    lastReport: async () => undefined,
    send: async (_seat, text) => {
      if (fails) throw new Error("broker refused the message");
      sends.push(text);
    },
  };
  return { sends, ports };
}

const merge = (headSha: string): Verdict => ({ kind: "MERGE", headSha, evidence: {} });

/** The reviewer sends H1 back and passes every later head; every wake ends as `wakeAt` says. */
function phases(wakeAt: WakeOutcome, firstVerdict: (headSha: string) => Verdict = merge): ShepherdPhases {
  return {
    wake: async () => wakeAt,
    review: async (_ctx, request) => (request.headSha === H1 ? firstVerdict(H1) : merge(request.headSha)),
  };
}

function host(fake: FakeGitHub, ports: ExitNoticePorts, shepherd: ShepherdPhases, dbPath: string) {
  let clock = 0;
  spaceUpdates(fake, (ms) => void (clock += ms));
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, exitNotice: ports });
  const opened = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(shepherd)], routes, gatePollMs: 5 });
  hosts.push(opened);
  return { host: opened, store };
}

function world(fake: FakeGitHub, ports: ExitNoticePorts, shepherd: ShepherdPhases, dbPath = ":memory:"): FactoryHost {
  const { host: opened, store } = host(fake, ports, shepherd, dbPath);
  fake.addPr({ headSha: H1 });
  const runId = opened.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return Object.assign(opened, { runId });
}

const runOf = (host: FactoryHost): string => (host as FactoryHost & { runId: string }).runId;
const seatGates = (host: FactoryHost): string[] => host.pendingGates().flatMap((gate) => (SEAT_GATES.some((step) => gate.stepId.startsWith(step)) ? [gate.gate.id] : []));

/** H1 is red, every later head green. */
const redAtH1 = (fake: FakeGitHub) => (fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, pr.headSha === H1 ? "failure" : "success"), successRun("dag-check", 2)]));
const green = (fake: FakeGitHub) => (fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]));

async function waitingForHead(host: FactoryHost): Promise<void> {
  await vi.waitFor(() => expect(host.runtime.status(runOf(host))?.currentStep).toMatch(/^await-new-head/));
}

/** The pushed fix lands through the normal path: the owner's approve-merge gate opens at the new head, as before. */
async function ownerGateAtFix(host: FactoryHost, fake: FakeGitHub): Promise<void> {
  fake.pushHead(1, H2);
  await gateOpened(host, gateId(runOf(host), "approve-merge"));
  expect(host.gates.get(gateId(runOf(host), "approve-merge"))?.prompt).toContain(`at head ${H2}`);
}

describe("the 2026-10-08 owner-queue replay: seat work goes to the registering seat, not the owner", () => {
  it("ci-failed with no fixer left on the roster: the seat gets a fix-round notice and the run awaits a new head", async () => {
    const fake = fakeGitHub();
    redAtH1(fake);
    const { sends, ports } = seat();
    const host = world(fake, ports, phases({ kind: "unhandled", reason: GONE }));

    await waitingForHead(host);

    expect(seatGates(host)).toEqual([]);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain(`${REPO}#1`);
    expect(sends[0]).toContain(`head ${H1}`);
    expect(sends[0]).toContain("validate");
    expect(sends[0]).toContain("no owner gate");
    expect(sends[0]).toContain("successor");
    await ownerGateAtFix(host, fake);
  });

  it("sh-sent-back after a FIX_FIRST no agent took: the seat gets the review's send-back and the run awaits a new head", async () => {
    const fake = fakeGitHub();
    green(fake);
    const { sends, ports } = seat();
    const host = world(fake, ports, phases({ kind: "unhandled", reason: GONE }, () => ({ kind: "FIX_FIRST", headSha: H1, text: "missing test" })));

    await waitingForHead(host);

    expect(seatGates(host)).toEqual([]);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("FIX_FIRST");
    expect(sends[0]).toContain(`head ${H1}`);
    await ownerGateAtFix(host, fake);
  });

  it("sh-sent-back after a fixer exited with no push: the seat gets the exit notice and the run awaits a new head", async () => {
    const fake = fakeGitHub();
    green(fake);
    const { sends, ports } = seat();
    const exited: WakeOutcome = { kind: "unhandled", exited: true, reason: `impl-a exited without pushing a new head past ${H1}`, wake: { agent: "impl-a", mode: "resume" } };
    const host = world(fake, ports, phases(exited, () => ({ kind: "FIX_FIRST", headSha: H1, text: "missing test" })));

    await waitingForHead(host);

    expect(seatGates(host)).toEqual([]);
    expect(sends).toHaveLength(1);
    await ownerGateAtFix(host, fake);
  });

  it("stuck-behind: the seat gets an update-branch notice and Shepherd updates the branch again", async () => {
    const fake = fakeGitHub();
    fake.onGetPr = (pr) => (fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]), (pr.behind = fake.effects.updateBranch < 12));
    const { sends, ports } = seat();
    const host = world(fake, ports, phases({ kind: "unhandled", reason: GONE }));

    await gateOpened(host, gateId(runOf(host), "approve-merge"));

    expect(seatGates(host)).toEqual([]);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends[0]).toContain("still behind its base");
    expect(sends[0]).toContain("update-branch");
    expect(fake.effects.updateBranch).toBe(12);
  });
});

describe("a spent repair budget", () => {
  it("tells the seat and waits for a head it pushes, with no sent-back gate", async () => {
    const fake = fakeGitHub();
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, "failure"), successRun("dag-check", 2)]);
    let pushed = 0;
    const wakeAt = async (): Promise<WakeOutcome> => (fake.pushHead(1, fakeSha(`red${++pushed}`)), { kind: "woken", agent: "impl-a" });
    const { sends, ports } = seat();
    const host = world(fake, ports, { ...phases({ kind: "unhandled", reason: GONE }), wake: wakeAt });

    await waitingForHead(host);
    await vi.waitFor(() => expect(sends).toHaveLength(1));

    expect(seatGates(host)).toEqual([]);
    expect(sends[0]).toContain("repair budget");
    expect(sends[0]).toContain("validate");
  });
});

describe("a seat notice replayed after a restart", () => {
  it("is not sent again, and the stuck-behind retry it answered replays to the same approve-merge gate", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp2033-")), "factory.db");
    const fake = fakeGitHub();
    fake.onGetPr = (pr) => (fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]), (pr.behind = fake.effects.updateBranch < 12));
    const { sends, ports } = seat();
    const shepherd = phases({ kind: "unhandled", reason: GONE });
    const first = world(fake, ports, shepherd, dbPath);
    await gateOpened(first, gateId(runOf(first), "approve-merge"));
    const told = sends.length;
    first.close();

    const { host: second } = host(fake, ports, shepherd, dbPath);
    expect(await second.adopt()).toEqual([runOf(first)]);
    await gateOpened(second, gateId(runOf(first), "approve-merge"));

    expect(sends).toHaveLength(told);
    expect(fake.effects.updateBranch).toBe(12);
  });
});

describe("an owner gate opens only when the seat notice cannot be sent", () => {
  it("opens ci-failed when the seat notice fails, naming the failure", async () => {
    const fake = fakeGitHub();
    redAtH1(fake);
    const { ports } = seat(true);
    const host = world(fake, ports, phases({ kind: "unhandled", reason: GONE }));

    await gateOpened(host, gateId(runOf(host), "ci-failed"));

    expect(host.gates.get(gateId(runOf(host), "ci-failed"))?.prompt).toContain("the seat notice failed");
  });

  it("opens stuck-behind when no single seat owns the repo", async () => {
    const fake = fakeGitHub();
    fake.onGetPr = (pr) => (fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]), (pr.behind = true));
    const { ports } = seat();
    const host = world(fake, { ...ports, seatFor: () => undefined }, phases({ kind: "unhandled", reason: GONE }));

    await gateOpened(host, gateId(runOf(host), "stuck-behind"));
  });

  it("leaves the owner-gate approve-merge as it was: a green, reviewed head asks the owner and tells no seat", async () => {
    const fake = fakeGitHub();
    green(fake);
    const { sends, ports } = seat();
    const host = world(fake, ports, phases({ kind: "unhandled", reason: GONE }));

    await gateOpened(host, gateId(runOf(host), "approve-merge"));

    expect(host.gates.get(gateId(runOf(host), "approve-merge"))?.prompt).toContain(`at head ${H1}`);
    expect(sends).toEqual([]);
  });
});
