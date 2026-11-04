import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { DEMO_REPO, demoSpec, fakeBuild, shaOf, stubbedRoutes, type FakeBuild, type GateScript } from "../test-support/build-surface.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { failureGroups, gateFailureClass, gateRunRoute, GATE_ROUTE_TABLE } from "./failure-route.js";
import { BUILD_SURFACE_WORKFLOW } from "./manifest.js";
import type { GateRun } from "./schemas.js";
import { buildSurfaceWorkflow } from "./workflow.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function start(fake: FakeBuild): { host: FactoryHost; runId: string } {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [buildSurfaceWorkflow()], routes: stubbedRoutes(fake), gatePollMs: 5 });
  hosts.push(host);
  return { host, runId: host.runtime.start(BUILD_SURFACE_WORKFLOW, { repo: DEMO_REPO, spec: "docs/BUILD-SPEC.md" }) };
}

const stepsOf = (host: FactoryHost, runId: string, prefix: string) => Object.keys(host.runtime.status(runId)!.stepResults).filter((step) => step.startsWith(prefix));
const oneSlice = (gate: Record<string, unknown> = {}) => demoSpec({ deploy: undefined, gate: { command: ["make", "gates"], evidence: "evidence/{slice}/{head}", ...gate }, slices: [{ id: "shell", title: "Shell", brief: "b" }] });
const red = (failure: Record<string, unknown>, gate = "G4") => ({ gate, pass: false, failure });
const greenRun = { status: 0, records: [{ gate: "G4", pass: true }] };

function gateRun(rows: { gate: string; failure?: { class?: string; signature?: string } }[]): GateRun {
  return { head: shaOf(1), exitCode: 1, pass: false, gates: rows.map((row) => ({ ...row, pass: false, evidence: `evidence/${row.gate}.json` })), problems: [] };
}

async function acceptFinalWalk(host: FactoryHost, runId: string) {
  await gateOpened(host, gateId(runId, "final-walk"));
  host.runtime.signal(runId, "final-walk", { decision: "accept", headSha: shaOf(9001) }, OWNER);
  return host.runtime.wait(runId);
}

describe("the gate failure route table", () => {
  it.each([
    ["code", "fix"],
    ["infra", "retry"],
    ["gate-broken", "stop"],
    ["spec", "stop"],
  ] as const)("routes class %s to %s", (failureClass, route) => {
    expect(GATE_ROUTE_TABLE[failureClass]).toBe(route);
    expect(gateRunRoute(gateRun([{ gate: "G1", failure: { class: failureClass } }]))).toBe(route);
  });

  it.each([[undefined], ["cosmic-rays"], [""]])("reads the unknown class %s as code, so it goes to the capped fix loop", (raw) => {
    expect(gateFailureClass(raw)).toBe("code");
    expect(gateRunRoute(gateRun([{ gate: "G1", failure: { ...(raw !== undefined && { class: raw }) } }]))).toBe("fix");
  });

  it("sends a red run with no failing record to fix", () => {
    expect(gateRunRoute(gateRun([]))).toBe("fix");
  });

  it("lets stop beat retry and retry beat fix when records disagree", () => {
    const code = { gate: "G1", failure: { class: "code" } };
    const infra = { gate: "G2", failure: { class: "infra" } };
    const spec = { gate: "G3", failure: { class: "spec" } };

    expect(gateRunRoute(gateRun([code, infra]))).toBe("retry");
    expect(gateRunRoute(gateRun([code, infra, spec]))).toBe("stop");
  });
});

describe("failure signature groups", () => {
  it("groups signatures that differ only in their masked parts, and keeps other failures apart", () => {
    const groups = failureGroups(gateRun([
      { gate: "G1", failure: { class: "gate-broken", signature: "fixture missing at line 41 after 300 ms" } },
      { gate: "G2", failure: { class: "gate-broken", signature: "fixture missing at line 97 after 12 ms" } },
      { gate: "G3", failure: { class: "gate-broken", signature: "renderer refused the viewport size" } },
    ]), "stop");

    expect(groups.map((group) => group.gates.map((gate) => gate.gate))).toEqual([["G1", "G2"], ["G3"]]);
  });

  it("never groups across classes, and uses the gate name when a record has no signature", () => {
    const groups = failureGroups(gateRun([
      { gate: "G1", failure: { class: "gate-broken", signature: "same words" } },
      { gate: "G2", failure: { class: "spec", signature: "same words" } },
      { gate: "G3", failure: { class: "spec" } },
    ]), "stop");

    expect(groups.map((group) => [group.class, group.signature])).toEqual([["gate-broken", "same words"], ["spec", "same words"], ["spec", "G3"]]);
  });

  it("leaves out gates on another route", () => {
    const groups = failureGroups(gateRun([{ gate: "G1", failure: { class: "code" } }, { gate: "G2", failure: { class: "spec" } }]), "stop");

    expect(groups.flatMap((group) => group.gates.map((gate) => gate.gate))).toEqual(["G2"]);
  });
});

describe("build-surface routing a red gate by its evidence", () => {
  it("sends a code failure to a fix round", async () => {
    const gate: GateScript = (_slice, _head, round) => (round === 0 ? { status: 1, records: [red({ class: "code" })] } : greenRun);
    const fake = fakeBuild({ spec: oneSlice(), gate });
    const { host, runId } = start(fake);

    const run = await acceptFinalWalk(host, runId);

    expect(run.status).toBe("completed");
    expect(fake.agentCalls).toContain("bs-fix:shell:1");
    expect(fake.filed).toEqual([]);
  });

  it("sends an unclassified failure to a fix round, as a record with no failure always went", async () => {
    const gate: GateScript = (_slice, _head, round) => (round === 0 ? { status: 1, records: [{ gate: "G4", pass: false }] } : greenRun);
    const fake = fakeBuild({ spec: oneSlice(), gate });
    const { host, runId } = start(fake);

    await acceptFinalWalk(host, runId);

    expect(fake.agentCalls).toContain("bs-fix:shell:1");
  });

  it("clears an infra failure with one rerun after a healthy probe, counting no fix round", async () => {
    const gate: GateScript = (_slice, _head, round) => (round === 0 ? { status: 1, records: [red({ class: "infra" })] } : greenRun);
    const fake = fakeBuild({ spec: oneSlice({ health: ["make", "health"] }), gate });
    const { host, runId } = start(fake);

    const run = await acceptFinalWalk(host, runId);

    expect(run.status).toBe("completed");
    expect(fake.commands.filter((command) => command.argv[1] === "health")).toHaveLength(1);
    expect(fake.agentCalls.filter((call) => call.startsWith("bs-fix"))).toEqual([]);
    expect(stepsOf(host, runId, "bs-gates:shell")).toHaveLength(2);
  });

  it("reruns once with no probe in the spec, then parks with an owner item that a retry answers", async () => {
    const gate: GateScript = (_slice, _head, round) => (round < 2 ? { status: 1, records: [red({ class: "infra", signature: "runner lost" })] } : greenRun);
    const fake = fakeBuild({ spec: oneSlice(), gate });
    const { host, runId } = start(fake);

    await gateOpened(host, gateId(runId, "infra-park:shell:0:1"));
    host.runtime.signal(runId, "infra-park:shell:0:1", { decision: "retry", headSha: shaOf(1) }, OWNER);
    const run = await acceptFinalWalk(host, runId);

    expect(run.status).toBe("completed");
    expect(fake.agentCalls.filter((call) => call.startsWith("bs-fix"))).toEqual([]);
    expect(stepsOf(host, runId, "bs-gates:shell")).toHaveLength(3);
  });

  it("parks at once when the health probe fails, without rerunning the gates", async () => {
    const fake = fakeBuild({ spec: oneSlice({ health: ["make", "health"] }), health: 1, gate: () => ({ status: 1, records: [red({ class: "infra" })] }) });
    const { host, runId } = start(fake);

    await gateOpened(host, gateId(runId, "infra-park:shell:0:0"));

    expect(stepsOf(host, runId, "bs-gates:shell")).toHaveLength(1);
    host.runtime.signal(runId, "infra-park:shell:0:0", { decision: "stop", headSha: shaOf(1) }, OWNER);
    const run = await host.runtime.wait(runId);
    expect(run.error).toMatch(/the owner stopped it on an infra failure/);
  });

  it("does not spend the fix-round cap or the no-improvement count on infra failures", async () => {
    const gate: GateScript = (_slice, _head, round) => (round < 4 ? { status: 1, records: [red({ class: "infra" })] } : greenRun);
    const fake = fakeBuild({ spec: demoSpec({ deploy: undefined, maxFixRounds: 0, noImprovementRounds: 1, slices: [{ id: "shell", title: "Shell", brief: "b" }] }), gate });
    const { host, runId } = start(fake);

    await gateOpened(host, gateId(runId, "infra-park:shell:0:1"));
    host.runtime.signal(runId, "infra-park:shell:0:1", { decision: "retry", headSha: shaOf(1) }, OWNER);
    await gateOpened(host, gateId(runId, "infra-park:shell:0:3"));
    host.runtime.signal(runId, "infra-park:shell:0:3", { decision: "retry", headSha: shaOf(1) }, OWNER);
    const run = await acceptFinalWalk(host, runId);

    expect(run.status).toBe("completed");
  });

  it.each(["gate-broken", "spec"])("stops the slice on a %s failure and files a task, with no fix round", async (failureClass) => {
    const fake = fakeBuild({ spec: oneSlice(), gate: () => ({ status: 1, records: [red({ class: failureClass, signature: "proof fixture absent" })] }) });
    const { host, runId } = start(fake);

    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("failed");
    expect(run.error).toContain(`slice shell stopped: ${failureClass} failure at G4 (filed demo/DM-100)`);
    expect(fake.filed).toEqual([expect.objectContaining({ task: "demo/DM-100", title: expect.stringContaining(`${failureClass} failure at G4`), notes: expect.stringContaining("proof fixture absent") })]);
    expect(fake.agentCalls).toEqual(["bs-implement:shell"]);
  });

  it("files one task for a failure two gates share and one for a different failure", async () => {
    const records = [red({ class: "spec", signature: "target 12 not in spec" }, "G1"), red({ class: "spec", signature: "target 40 not in spec" }, "G2"), red({ class: "gate-broken", signature: "renderer gone" }, "G3")];
    const fake = fakeBuild({ spec: oneSlice(), gate: () => ({ status: 1, records }) });
    const { host, runId } = start(fake);

    await host.runtime.wait(runId);

    expect(fake.filed.map((entry) => entry.title)).toEqual([expect.stringContaining("at G1, G2"), expect.stringContaining("at G3")]);
  });

  it("does not file a second task when another slice stops on the same failure", async () => {
    const slices = [{ id: "alpha", title: "Alpha", brief: "b" }, { id: "beta", title: "Beta", brief: "b" }];
    const fake = fakeBuild({ spec: demoSpec({ deploy: undefined, concurrency: 1, slices }), gate: () => ({ status: 1, records: [red({ class: "gate-broken", signature: "renderer gone" })] }) });
    const { host, runId } = start(fake);

    const run = await host.runtime.wait(runId);

    expect(run.error).toMatch(/alpha \(.*filed demo\/DM-100\).*beta \(.*filed demo\/DM-100\)/);
    expect(fake.filed).toHaveLength(1);
  });

  it("still stops the slice when the task cannot be filed, and says why", async () => {
    const fake = fakeBuild({ spec: oneSlice(), taskError: "daemon down", gate: () => ({ status: 1, records: [red({ class: "spec" })] }) });
    const { host, runId } = start(fake);

    const run = await host.runtime.wait(runId);

    expect(run.error).toContain("spec failure at G4 (no task filed: daemon down)");
  });
});
