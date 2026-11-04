import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { DEMO_REPO, demoSpec, fakeBuild, shaOf, stubbedRoutes } from "../test-support/build-surface.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { BUILD_SURFACE_WORKFLOW } from "./manifest.js";
import { buildSurfaceWorkflow } from "./workflow.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

describe("a stopped run's branch whose gate record is written as the gate README documents a pass", () => {
  it("a passing record with failure: null is picked up as green", async () => {
    const head = shaOf(500);
    const spec = demoSpec({ slices: [{ id: "shell", title: "App shell", brief: "Build the shell." }] });
    const record = { gate: "G1", head, slice: "SHELL", pass: true, dirty: false, score: 1, failure: null };
    const fake = fakeBuild({ spec, branches: { "build-surface/shell": head }, evidence: { [`/work/demo-repo/evidence/shell/${head}`]: [record] } });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [buildSurfaceWorkflow()], routes: stubbedRoutes(fake), gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start(BUILD_SURFACE_WORKFLOW, { repo: DEMO_REPO, spec: "docs/BUILD-SPEC.md" });
    await gateOpened(host, gateId(runId, "deploy-approve:shell"));
    host.runtime.signal(runId, "deploy-approve:shell", { decision: "deploy", headSha: shaOf(9001) }, OWNER);
    await gateOpened(host, gateId(runId, "final-walk"));
    host.runtime.signal(runId, "final-walk", { decision: "accept", headSha: shaOf(9001) }, OWNER);

    await host.runtime.wait(runId);

    expect(fake.agentCalls).toEqual(["bs-review:shell:0:0"]);
  });
});
