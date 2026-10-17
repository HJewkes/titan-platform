import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened, outsideActions } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { CHECKS_RECHECK_MS } from "../workflows/await-head.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { ShepherdPhases, WakeOutcome, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const H2 = fakeSha("head2");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const exited: WakeOutcome = { kind: "unhandled", exited: true, reason: `impl-a exited without pushing a new head past ${H1}`, wake: { agent: "impl-a", mode: "resume" } };

/** The fixer takes each wake and exits with no push, as the successor on td#894 and the implementer on tp#1765 did. */
function world(fake: FakeGitHub) {
  const wakes: WakeRequest[] = [];
  const sends: string[] = [];
  const phases: ShepherdPhases = { wake: async (_ctx, request) => (wakes.push(request), exited), review: async () => ({ kind: "none" }) };
  const ports: ExitNoticePorts = { seatFor: () => "demo-coord", lastReport: async () => undefined, send: async (_seat, text) => void sends.push(text) };
  const clock = { now: 0 };
  const tick = async (ms: number, signal: AbortSignal) => ((clock.now += ms), sleep(1, signal));
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock.now, sleep: tick, exitNotice: ports });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { host, runId, wakes, sends, clock };
}

function result(host: FactoryHost, runId: string, stepId: string): unknown {
  return Object.values(host.runtime.status(runId)!.stepResults).find((step) => step.stepId === stepId)?.data;
}

async function waitingForHead(host: FactoryHost, runId: string): Promise<void> {
  await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toMatch(/^await-new-head/));
}

const job = (name: string, id: number, workflowRunId: number, conclusion: string | null): CheckRun => ({
  ...successRun(name, id, "2026-01-01T00:00:00Z", conclusion ?? "success"),
  workflowRunId,
  ...(conclusion === null && { status: "in_progress", conclusion: null }),
});

/** validate is red at H1 until `fixed`; `preview`, a check the base does not require, is red there too unless `previewGreen`. */
function redValidate(fake: FakeGitHub, state: { fixed: boolean; previewGreen?: boolean }): void {
  fake.onGetPr = (pr) => {
    const red = pr.headSha === H1;
    fake.setRuns(pr.headSha, [
      outsideActions(successRun("validate", 1, undefined, red && !state.fixed ? "failure" : "success")),
      successRun("dag-check", 2),
      outsideActions(successRun("preview", 3, undefined, red && !state.fixed && state.previewGreen !== true ? "failure" : "success")),
    ]);
  };
}

describe("a red at one head whose CI turns green at that same head", () => {
  it("td#894: a cancelled run's red beside a live run is no red, so no repair or wake is spent and the live run's green lands", async () => {
    const fake = fakeGitHub();
    fake.rules.contexts = ["check"];
    let reads = 0;
    const cancelled = [job("build", 11, 2002, "cancelled"), job("check", 12, 2002, "failure")];
    const live = (passed: boolean) => (passed ? [job("build", 21, 1001, "success"), job("check", 22, 1001, "success")] : [job("build", 21, 1001, null)]);
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [...cancelled, ...live(++reads > 3)]);
    const { host, runId, wakes } = world(fake);

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(wakes).toEqual([]);
    expect(result(host, runId, "sh-repair")).toBeUndefined();
    expect(result(host, runId, "ci-wait:0")).toMatchObject({ result: { headSha: H1, verdict: "green" } });
  });

  it("tp#1765: the fixer pushes nothing, a rerun passes at the same head, and the wait resumes there with its reason recorded", async () => {
    const fake = fakeGitHub();
    const state = { fixed: false };
    redValidate(fake, state);
    const { host, runId, wakes, sends } = world(fake);
    await waitingForHead(host, runId);

    state.fixed = true;
    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(sends).toHaveLength(1);
    expect(result(host, runId, "await-new-head:0")).toMatchObject({ result: { headSha: H1, green: true, why: expect.stringContaining(`at ${H1} with no new head`) } });
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`at head ${H1}`);
  });

  it("a new head arriving while H1 is still red wins, as before", async () => {
    const fake = fakeGitHub();
    redValidate(fake, { fixed: false });
    const { host, runId } = world(fake);
    await waitingForHead(host, runId);

    fake.pushHead(1, H2);
    await gateOpened(host, gateId(runId, "approve-merge"));

    const waited = result(host, runId, "await-new-head:0");
    expect(waited).toMatchObject({ result: { headSha: H2 } });
    expect(waited).not.toMatchObject({ result: { green: true } });
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`at head ${H2}`);
  });

  it("a head that stays red keeps waiting, even when a check the base does not require turns green", async () => {
    const fake = fakeGitHub();
    const state = { fixed: false, previewGreen: false };
    redValidate(fake, state);
    const { host, runId, clock } = world(fake);
    await waitingForHead(host, runId);

    state.previewGreen = true;
    const from = clock.now;
    const ended = () => result(host, runId, "await-new-head:0");
    await vi.waitFor(() => expect(ended() !== undefined || clock.now - from > 3 * CHECKS_RECHECK_MS).toBe(true));

    expect(ended()).toBeUndefined();
    expect(host.runtime.status(runId)?.currentStep).toMatch(/^await-new-head/);
    expect(host.pendingGates().filter((gate) => gate.runId === runId)).toEqual([]);
  });
});
