import { partialFake } from "@titan-design/test-kit";
import type { GitHubPort, PullRequest } from "@titan-design/github";
import { openGate } from "@titan-design/hitl";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { DEMO_REPO, demoSpec, fakeBuild, stubbedRoutes } from "../test-support/build-surface.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { AbandonRefused, abandonBuildSurface } from "./abandon.js";
import { BUILD_SURFACE_WORKFLOW } from "./manifest.js";
import { buildSurfaceWorkflow } from "./workflow.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A run parked on its first deploy gate, with slice `shell`'s PR #1 already opened. */
async function gatedRun(): Promise<{ host: FactoryHost; runId: string }> {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [buildSurfaceWorkflow()], routes: stubbedRoutes(fakeBuild()), gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start(BUILD_SURFACE_WORKFLOW, { repo: DEMO_REPO, spec: demoSpec() });
  await gateOpened(host, gateId(runId, "deploy-approve:shell"));
  return { host, runId };
}

const github = (state: "open" | "closed", merged = state === "closed"): Pick<GitHubPort, "getPr"> => ({ getPr: async () => partialFake<PullRequest>({ state, merged }) });
const ACTOR = "seat-coordinator";

/** The owner's second gate beside the deploy gate, opened as the run's own final walk is. */
function openFinalWalk(host: FactoryHost, runId: string): string {
  return openGate(host.gates, { id: gateId(runId, "final-walk"), prompt: "Walk the surface?", summary: "Walk the finished surface.", evidenceRef: "https://example.com/walk" }).id;
}

describe("abandoning a build-surface run", () => {
  it("cancels every pending gate and ends the run when its PR was merged outside Shepherd", async () => {
    const { host, runId } = await gatedRun();
    const walk = openFinalWalk(host, runId);

    const abandoned = await abandonBuildSurface(host, github("closed"), { runId, reason: "PR hand-merged", actor: ACTOR });

    await host.runtime.wait(runId).catch(() => undefined);
    expect(abandoned.cancelledGates.sort()).toEqual([gateId(runId, "deploy-approve:shell"), walk].sort());
    expect(host.pendingGates()).toEqual([]);
    expect(host.runtime.status(runId)?.status).toBe("cancelled");
  });

  it("records who abandoned and why on the run and on each cancelled gate", async () => {
    const { host, runId } = await gatedRun();
    const walk = openFinalWalk(host, runId);

    await abandonBuildSurface(host, github("closed"), { runId, reason: "PR hand-merged", actor: ACTOR });

    await host.runtime.wait(runId).catch(() => undefined);
    const recorded = `abandoned by ${ACTOR}: PR hand-merged`;
    expect(host.runtime.status(runId)?.error).toBe(recorded);
    expect([walk, gateId(runId, "deploy-approve:shell")].map((id) => host.gates.get(id)?.reason)).toEqual([recorded, recorded]);
  });

  it("refuses while the PR is open, names its state, and changes nothing", async () => {
    const { host, runId } = await gatedRun();

    await expect(abandonBuildSurface(host, github("open"), { runId, reason: "x", actor: ACTOR })).rejects.toThrow(/owner\/demo-repo#1 is open/);

    expect(host.runtime.status(runId)?.status).toBe("paused");
    expect(host.pendingGates()).toHaveLength(1);
  });

  it("refuses when no GitHub port can read the PR", async () => {
    const { host, runId } = await gatedRun();

    await expect(abandonBuildSurface(host, undefined, { runId, reason: "x", actor: ACTOR })).rejects.toThrow(AbandonRefused);

    expect(host.pendingGates()).toHaveLength(1);
  });

  it("refuses a run that already ended", async () => {
    const { host, runId } = await gatedRun();
    await abandonBuildSurface(host, github("closed"), { runId, reason: "first", actor: ACTOR });

    await expect(abandonBuildSurface(host, github("closed"), { runId, reason: "again", actor: ACTOR })).rejects.toThrow(/already/);
  });
});
