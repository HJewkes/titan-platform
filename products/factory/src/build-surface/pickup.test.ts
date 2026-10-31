import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { DEMO_REPO, demoSpec, fakeBuild, shaOf, stubbedRoutes, type FakeBuild } from "../test-support/build-surface.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { BUILD_SURFACE_WORKFLOW } from "./manifest.js";
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

describe("a fresh build-surface start over a branch a stopped run left behind", () => {
  /** A one-slice spec whose branch a stopped run left at `head`, with the gate records it wrote there. */
  function pickUp(records: object[]) {
    const head = shaOf(500);
    const spec = demoSpec({ slices: [{ id: "shell", title: "App shell", brief: "Build the shell." }] });
    const evidence = { [`/work/demo-repo/evidence/shell/${head}`]: records.map((record) => ({ ...record, head })) };
    const fake = fakeBuild({ spec, branches: { "build-surface/shell": head }, evidence });
    return { fake, head, ...start(fake) };
  }

  it("picks up a branch a stopped run left green at its head: no implement turn and no gate rerun, straight to review", async () => {
    const { fake, head, host, runId } = pickUp([{ gate: "G1", pass: true }, { gate: "G4", pass: true, score: 1 }]);
    await approveDeploy(host, runId, "shell", 1);
    await gateOpened(host, gateId(runId, "final-walk"));
    host.runtime.signal(runId, "final-walk", { decision: "accept", headSha: shaOf(9001) }, OWNER);

    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(fake.agentCalls).toEqual(["bs-review:shell:0:0"]);
    expect(fake.commands.filter((command) => command.argv[1] === "gates")).toEqual([]);
    expect(fake.commands.find((command) => command.argv[1] === "preview")!.env.BS_HEAD).toBe(head);
  });

  it("picks up a branch whose passing gate record carries failure: null", async () => {
    const { fake, host, runId } = pickUp([{ gate: "G1", slice: "SHELL", pass: true, dirty: false, score: 1, failure: null }]);
    await approveDeploy(host, runId, "shell", 1);
    await gateOpened(host, gateId(runId, "final-walk"));
    host.runtime.signal(runId, "final-walk", { decision: "accept", headSha: shaOf(9001) }, OWNER);

    await host.runtime.wait(runId);

    expect(fake.agentCalls).toEqual(["bs-review:shell:0:0"]);
  });

  it("implements again when the left branch has a failing gate at its head", async () => {
    const { fake, host, runId } = pickUp([{ gate: "G1", pass: true }, { gate: "G4", pass: false, score: 0.4 }]);
    await approveDeploy(host, runId, "shell", 1);
    await gateOpened(host, gateId(runId, "final-walk"));
    host.runtime.signal(runId, "final-walk", { decision: "accept", headSha: shaOf(9001) }, OWNER);

    await host.runtime.wait(runId);

    expect(fake.agentCalls[0]).toBe("bs-implement:shell");
  });
});

describe("a fresh build-surface start over a slice an earlier run already merged", () => {
  const head = shaOf(500);
  const slices = [{ id: "shell", title: "App shell", brief: "Build the shell." }, { id: "pages", title: "Pages", brief: "Build the pages.", dependsOn: ["shell"] }];

  /** Runs a two-slice spec whose first slice's branch is on the remote with `pr`, and returns the fake after the final walk. */
  async function resume(options: { pr: Record<string, unknown>; ancestors?: string[] }) {
    const fake = fakeBuild({ spec: demoSpec({ slices }), branches: { "build-surface/shell": head }, prs: { "build-surface/shell": options.pr }, ancestors: options.ancestors });
    const { host, runId } = start(fake);
    await approveDeploy(host, runId, "pages", 1);
    await gateOpened(host, gateId(runId, "final-walk"));
    host.runtime.signal(runId, "final-walk", { decision: "accept", headSha: shaOf(9001) }, OWNER);
    return { fake, run: await host.runtime.wait(runId) };
  }

  it("skips a slice whose head is in the base and builds the slice that depends on it", async () => {
    const { fake, run } = await resume({ pr: { number: 7, state: "closed", merged: false, mergeSha: null, headSha: head }, ancestors: [head] });

    expect(run.status).toBe("completed");
    expect(fake.agentCalls.some((call) => call.endsWith(":shell"))).toBe(false);
    expect(fake.agentCalls[0]).toBe("bs-implement:pages");
  });

  it("skips a squash-merged slice whose PR reports merged, though its head is not in the base", async () => {
    const { fake, run } = await resume({ pr: { number: 7, state: "closed", merged: true, mergeSha: shaOf(700), headSha: head } });

    expect(run.status).toBe("completed");
    expect(fake.agentCalls.some((call) => call.endsWith(":shell"))).toBe(false);
    expect(fake.agentCalls[0]).toBe("bs-implement:pages");
  });

  it("builds a slice again when its PR is open and its head is not in the base", async () => {
    const spec = demoSpec({ slices: [slices[0]] });
    const fake = fakeBuild({ spec, branches: { "build-surface/shell": head }, prs: { "build-surface/shell": { number: 7, state: "open", merged: false, mergeSha: null, headSha: head } } });
    const { host, runId } = start(fake);
    await approveDeploy(host, runId, "shell", 7);
    await gateOpened(host, gateId(runId, "final-walk"));
    host.runtime.signal(runId, "final-walk", { decision: "accept", headSha: shaOf(9007) }, OWNER);

    await host.runtime.wait(runId);

    expect(fake.agentCalls[0]).toBe("bs-implement:shell");
  });
});
