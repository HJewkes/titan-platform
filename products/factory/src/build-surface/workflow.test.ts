import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { DEMO_REPO, demoSpec, fakeBuild, shaOf, stubbedRoutes, type FakeBuild, type GateScript } from "../test-support/build-surface.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { BUILD_SURFACE_WORKFLOW } from "./manifest.js";
import { buildSurfaceAgentRoutes } from "./routes.js";
import { buildSurfaceWorkflow } from "./workflow.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function start(fake: FakeBuild): { host: FactoryHost; runId: string } {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [buildSurfaceWorkflow()], routes: stubbedRoutes(fake), gatePollMs: 5 });
  hosts.push(host);
  return { host, runId: host.runtime.start(BUILD_SURFACE_WORKFLOW, { repo: DEMO_REPO, spec: "docs/BUILD-SPEC.md" }) };
}

async function approveDeploy(host: FactoryHost, runId: string, slice: string, pr: number): Promise<void> {
  const step = `deploy-approve:${slice}`;
  await gateOpened(host, gateId(runId, step));
  host.runtime.signal(runId, step, { decision: "deploy", headSha: shaOf(9000 + pr) }, OWNER);
}

/** Answers both deploy gates and the final walk, in the order the run opens them. */
async function drive(host: FactoryHost, runId: string) {
  await approveDeploy(host, runId, "shell", 1);
  await approveDeploy(host, runId, "panel", 2);
  await gateOpened(host, gateId(runId, "final-walk"));
  host.runtime.signal(runId, "final-walk", { decision: "accept", headSha: shaOf(9002) }, OWNER);
  return host.runtime.wait(runId);
}

const stepsOf = (host: FactoryHost, runId: string) => Object.keys(host.runtime.status(runId)!.stepResults);

describe("build-surface on a toy two-slice spec with every agent step stubbed", () => {
  it("builds the slices in dependency order, fixes a red gate, lands both and ends at an accepted final walk", async () => {
    const gate: GateScript = (slice, _head, round) => (slice === "shell" && round === 0 ? { status: 1, records: [{ gate: "G4", pass: false, score: 0.4 }] } : { status: 0, records: [{ gate: "G4", pass: true, score: 1 }] });
    const fake = fakeBuild({ gate });
    const { host, runId } = start(fake);

    const run = await drive(host, runId);

    expect(run.status).toBe("completed");
    expect(fake.agentCalls).toEqual(["bs-implement:shell", "bs-fix:shell:1", "bs-review:shell:1:0", "bs-implement:panel", "bs-review:panel:0:0"]);
    expect(fake.registered).toEqual([
      { repo: DEMO_REPO, pr: 1, task: "demo/DM-1", implementer: "bs-demo-repo-shell" },
      { repo: DEMO_REPO, pr: 2, task: "demo/DM-1", implementer: "bs-demo-repo-panel" },
    ]);
    const deploys = fake.commands.filter((command) => command.argv[1] === "deploy").map((command) => command.env.BS_MERGE_SHA);
    expect(deploys).toEqual([shaOf(9001), shaOf(9002)]);
  });

  it("runs the gates at the head the implementer reported, with the evidence path the spec names", async () => {
    const fake = fakeBuild();
    const { host, runId } = start(fake);

    await drive(host, runId);

    const gateRun = fake.commands.find((command) => command.argv[1] === "gates")!;
    expect(gateRun.env).toMatchObject({ BS_SLICE: "shell", BS_HEAD: shaOf(1), BS_EVIDENCE: `/work/demo-repo/evidence/shell/${shaOf(1)}`, BS_BRANCH: "build-surface/shell" });
  });

  it("stops a slice whose report is rejected twice, and never starts the slice that depends on it", async () => {
    const fake = fakeBuild({ reportCheck: () => 1 });
    const { host, runId } = start(fake);

    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/0 of 2 slices merged.*shell \(slice shell stopped: the report was rejected twice: diff leaves the partition.*not started: panel/);
    expect(fake.agentCalls).toEqual(["bs-implement:shell", "bs-fix:shell:0r"]);
  });

  it("stops a slice once one gate fails three rounds with no score improvement", async () => {
    const fake = fakeBuild({ gate: () => ({ status: 1, records: [{ gate: "G6", pass: false, score: 0.5 }] }) });
    const { host, runId } = start(fake);

    const run = await host.runtime.wait(runId);

    expect(run.error).toMatch(/gate G6 failed 3 rounds with no score improvement/);
    expect(stepsOf(host, runId).filter((step) => step.startsWith("bs-gates:shell"))).toHaveLength(3);
  });

  it("cancels the run when a gate's sensitivity proof fails twice", async () => {
    const fake = fakeBuild({ gate: (_slice, _head, round) => ({ status: 3, records: [{ gate: "G4", pass: false, score: round }] }) });
    const { host, runId } = start(fake);

    const run = await host.runtime.wait(runId);

    expect(run.error).toMatch(/sensitivity proof failed twice/);
  });

  it("fails at plan when the spec names another repo, before any slice starts", async () => {
    const fake = fakeBuild({ spec: demoSpec({ repo: "owner/other-repo" }) });
    const { host, runId } = start(fake);

    const run = await host.runtime.wait(runId);

    expect(run.error).toMatch(/build spec is for owner\/other-repo, not owner\/demo-repo/);
    expect(fake.agentCalls).toEqual([]);
  });

  it.each([
    [10, "proceeds, since a fresh extraction already runs", "completed"],
    [20, "stops the slice", "failed"],
  ])("routes a preflight exit of %i: %s", async (status, _what, expected) => {
    const fake = fakeBuild({ spec: demoSpec({ preflight: { command: ["make", "preflight"] } }), preflight: status });
    const { host, runId } = start(fake);

    const run = expected === "completed" ? await drive(host, runId) : await host.runtime.wait(runId);

    expect(run.status).toBe(expected);
    if (expected === "failed") expect(run.error).toMatch(/slice shell stopped: blocked: exited 20: spec lock moved/);
  });

  it("stops the slice when its spend passes the slice cap", async () => {
    const spec = demoSpec({ sliceBudgetUsd: 0.25, slices: [{ id: "shell", title: "Shell", brief: "b", extract: { prompt: "extract" } }] });
    const fake = fakeBuild({ spec });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [buildSurfaceWorkflow()], routes: stubbedRoutes(fake).filter((route) => route.match !== "bs-extract").concat(buildSurfaceAgentRoutes(fake.ports).filter((route) => route.match === "bs-extract")), gatePollMs: 5 });
    hosts.push(host);

    const run = await host.runtime.wait(host.runtime.start(BUILD_SURFACE_WORKFLOW, { repo: DEMO_REPO, spec: "docs/BUILD-SPEC.md" }));

    expect(run.error).toMatch(/spend \$0\.50 is over the slice cap of \$0\.25/);
  });
});
