import { partialFake } from "@titan-design/test-kit";
import type { GitHubPort, PullRequest } from "@titan-design/github";
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

const github = (state: "open" | "closed"): Pick<GitHubPort, "getPr"> => ({ getPr: async () => partialFake<PullRequest>({ state, merged: state === "closed" }) });

describe("abandoning a build-surface run", () => {
  it("cancels the open gates with the reason and ends the run when its PR was merged outside Shepherd", async () => {
    const { host, runId } = await gatedRun();

    const abandoned = await abandonBuildSurface(host, github("closed"), { runId, reason: "PR hand-merged" });

    await host.runtime.wait(runId).catch(() => undefined);
    expect(abandoned.cancelledGates).toEqual([gateId(runId, "deploy-approve:shell")]);
    expect(host.runtime.status(runId)).toMatchObject({ status: "cancelled", error: "abandoned: PR hand-merged" });
    expect(host.pendingGates()).toEqual([]);
  });

  it("refuses while a PR the run opened is still open, and changes nothing", async () => {
    const { host, runId } = await gatedRun();

    await expect(abandonBuildSurface(host, github("open"), { runId, reason: "x" })).rejects.toThrow(/owner\/demo-repo#1 is still open/);

    expect(host.runtime.status(runId)?.status).toBe("paused");
    expect(host.pendingGates()).toHaveLength(1);
  });

  it("abandons a run with an open PR under --force without reading the PR", async () => {
    const { host, runId } = await gatedRun();

    await abandonBuildSurface(host, undefined, { runId, reason: "superseded", force: true });

    await host.runtime.wait(runId).catch(() => undefined);
    expect(host.runtime.status(runId)?.status).toBe("cancelled");
    expect(host.pendingGates()).toEqual([]);
  });

  it("refuses a run that already ended", async () => {
    const { host, runId } = await gatedRun();
    await abandonBuildSurface(host, github("closed"), { runId, reason: "first" });

    await expect(abandonBuildSurface(host, github("closed"), { runId, reason: "again" })).rejects.toThrow(AbandonRefused);
  });
});
