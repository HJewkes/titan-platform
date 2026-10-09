import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { GateResolver } from "@titan-design/hitl";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryWorkflows } from "../workflows.js";
import { DEVICE_CHECK } from "./land.js";
import { landPrRoutes } from "./land-pr.js";
import { devicePrWorkflow } from "./device-pr.js";

const H2 = fakeSha("head2");
const STEP = "Flash the board and check that the status light blinks";
const AT_DEVICE: GateResolver = Object.freeze({ class: "owner-terminal", id: "owner", channel: "factory-cli" });
const COORDINATOR: GateResolver = Object.freeze({ class: "coordinator", id: "seat", channel: "factory-cli" });

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** One PR at H1 whose required checks pass on every head, and a host running device-pr for it. */
function devicePrWorld(params: Record<string, string> = { deviceStep: STEP }): { host: FactoryHost; fake: FakeGitHub; runId: string } {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  const routes = landPrRoutes({ port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [devicePrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, runId: host.runtime.start("device-pr", { repo: REPO, pr: "1", ...params }) };
}

function stepIds(host: FactoryHost, runId: string): string[] {
  return Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
}

describe("device-pr", () => {
  it("is registered with the factory's workflows", () => {
    expect(factoryWorkflows.map((workflow) => workflow.name)).toContain("device-pr");
  });

  it("asks the owner at the device for the green head and merges it once on pass", async () => {
    const { host, fake, runId } = devicePrWorld();
    await gateOpened(host, gateId(runId, "device-confirm"));
    const gate = host.gates.get(gateId(runId, "device-confirm"))!;

    host.runtime.signal(runId, "device-confirm", { decision: "pass", headSha: H1 }, AT_DEVICE);
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(gate.summary).toBe(`Perform on the device at ${H1.slice(0, 8)}: ${STEP}`);
    expect(gate.evidenceRef).toBe(`https://github.com/${REPO}/pull/1/commits/${H1}`);
    expect(host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(fake.effects.merge).toBe(1);
    expect(fake.pr(1)).toMatchObject({ merged: true, headSha: H1 });
    expect(stepIds(host, runId).filter((id) => /device/.test(id))).toEqual(["device-confirm"]);
  });

  it("asks the device again at the new head after a fail and an awaited fix", async () => {
    const { host, fake, runId } = devicePrWorld();
    await gateOpened(host, gateId(runId, "device-confirm"));
    host.runtime.signal(runId, "device-confirm", { decision: "fail", headSha: H1, note: "light stays dark" }, AT_DEVICE);
    await gateOpened(host, gateId(runId, "ci-failed"));
    const red = host.gates.get(gateId(runId, "ci-failed"))!;
    host.runtime.signal(runId, "ci-failed", { decision: "await-fix", headSha: H1 }, OWNER);
    fake.pushHead(1, H2);
    await gateOpened(host, gateId(runId, "device-confirm", 1));

    expect(() => host.runtime.signal(runId, "device-confirm", { decision: "pass", headSha: H1 }, AT_DEVICE)).toThrow();
    host.runtime.signal(runId, "device-confirm", { decision: "pass", headSha: H2 }, AT_DEVICE);
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(red.prompt).toContain(DEVICE_CHECK);
    expect(host.gates.get(gateId(runId, "device-confirm", 1))?.summary).toContain(H2.slice(0, 8));
    expect(fake.effects).toMatchObject({ merge: 1, rerunFailedJobs: 0 });
    expect(fake.pr(1)).toMatchObject({ merged: true, headSha: H2 });
  });

  it("refuses an answer naming a different head and keeps the gate pending", async () => {
    const { host, fake, runId } = devicePrWorld();
    await gateOpened(host, gateId(runId, "device-confirm"));

    expect(() => host.runtime.signal(runId, "device-confirm", { decision: "pass", headSha: H2 }, AT_DEVICE)).toThrow();

    expect(host.gates.get(gateId(runId, "device-confirm"))?.status).toBe("pending");
    expect(fake.effects.merge).toBe(0);
  });

  it("refuses a coordinator's answer to device-confirm", async () => {
    const { host, fake, runId } = devicePrWorld();
    await gateOpened(host, gateId(runId, "device-confirm"));

    expect(() => host.runtime.signal(runId, "device-confirm", { decision: "pass", headSha: H1 }, COORDINATOR)).toThrow(/coordinator may not resolve/);

    expect(host.gates.get(gateId(runId, "device-confirm"))?.status).toBe("pending");
    expect(fake.effects.merge).toBe(0);
  });

  it("refuses the owner's answer from any channel but the terminal at the device", async () => {
    const { host, fake, runId } = devicePrWorld();
    await gateOpened(host, gateId(runId, "device-confirm"));

    expect(() => host.runtime.signal(runId, "device-confirm", { decision: "pass", headSha: H1 }, OWNER)).toThrow(/only through factory-cli/);

    expect(host.gates.get(gateId(runId, "device-confirm"))?.status).toBe("pending");
    expect(fake.effects.merge).toBe(0);
  });

  it("stops abandoned without merging when the owner abandons at the device", async () => {
    const { host, fake, runId } = devicePrWorld();
    await gateOpened(host, gateId(runId, "device-confirm"));

    host.runtime.signal(runId, "device-confirm", { decision: "abandon", headSha: H1 }, AT_DEVICE);
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(fake.effects.merge).toBe(0);
  });

  it.each([
    ["missing", {}],
    ["over 280 characters", { deviceStep: "x".repeat(281) }],
    ["more than one line", { deviceStep: "Flash the board\nthen reboot it" }],
    ["split by a next-line control", { deviceStep: "Flash the board\u0085then reboot it" }],
    ["split by a line separator", { deviceStep: "Flash the board then reboot it" }],
    ["split by a paragraph separator", { deviceStep: "Flash the board then reboot it" }],
    ["carrying a C1 control sequence introducer", { deviceStep: "Flash the board\u009b2J" }],
    ["carrying a right-to-left override", { deviceStep: "Flash the board ‮ti toober" }],
    ["carrying a bidi isolate", { deviceStep: "Flash the board ⁦then⁩ reboot it" }],
  ])("fails the run before any step when deviceStep is %s", async (_why, params) => {
    const { host, fake, runId } = devicePrWorld(params);

    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("failed");
    expect(stepIds(host, runId)).toEqual([]);
    expect(fake.effects.merge).toBe(0);
  });
});
