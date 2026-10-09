import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { WorkflowDefinition } from "../definition.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { BRANCH, shepherdFixture, shepherdRuns, type FixtureOptions, type ShepherdFixture } from "../test-support/shepherd.js";
import { codeRoute, step } from "../workflows/land.js";
import { HandoffNotBoundError, handoffRef, type HandoffRef, type HandoffRequest } from "./handoff.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const pr1: HandoffRequest = { repo: REPO, pr: 1, task: "demo/T-1", implementer: "factory-doc-demo", kind: "unknown" };

/** A workflow whose one step hands PR 1 to Shepherd from inside the step runner, as doc-change's `handoff` will. */
function parentWorkflow(): WorkflowDefinition {
  return {
    name: "parent",
    steps: [{ id: "handoff", kind: "dispatch" }],
    run: async (ctx) => {
      await step(ctx, "handoff", {}, z.looseObject({ runId: z.string(), created: z.boolean() }));
    },
  };
}

interface World extends ShepherdFixture {
  host: FactoryHost;
  handoff: HandoffRef;
}

function world(options: FixtureOptions = {}): World {
  const fixture = shepherdFixture(options);
  const handoff = handoffRef(fixture.routes.shepherd!);
  const parentRoute = codeRoute("handoff", () => 0, async () => handoff.register(pr1));
  const routes: FactoryRoutes = Object.assign([...fixture.routes, parentRoute], { database: fixture.routes.database, shepherd: fixture.routes.shepherd, bindHost: handoff.bind });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [...fixture.workflows, parentWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { ...fixture, host, handoff };
}

describe("handoff.register", () => {
  it("a second register for one repo#pr returns the first run with created false and starts no other", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const first = await w.handoff.register(pr1);
    const second = await w.handoff.register(pr1);

    expect(first.created).toBe(true);
    expect(second).toEqual({ runId: first.runId, created: false });
    expect(shepherdRuns(w.host)).toEqual([first.runId]);
  });

  it("registers from inside a running step of another run on the same host", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });

    const parentId = w.host.runtime.start("parent", {});
    const parent = await w.host.runtime.wait(parentId);

    expect(parent.status).toBe("completed");
    const [childId] = shepherdRuns(w.host);
    expect(Object.values(parent.stepResults)[0]?.data).toMatchObject({ result: { runId: childId, created: true } });
  });
});

describe("handoff.status", () => {
  it("reads landed and the merge sha from the run's sh-landed step", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await w.handoff.register(pr1);

    expect(w.handoff.status(runId)).toEqual({ status: "running" });
    await gateOpened(w.host, gateId(runId, "approve-merge"));
    w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);

    await vi.waitFor(() => expect(w.handoff.status(runId).outcome).toBe("landed"), { timeout: 4_000, interval: 10 });
    expect(w.fake.pr(1).mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(w.handoff.status(runId).mergeSha).toBe(w.fake.pr(1).mergeSha);
  });

  it("reads stopped and no merge sha when the run ended without a merge", async () => {
    const w = world();
    w.fake.addPr({ headSha: H1, headRef: BRANCH, mergeableState: "dirty" });
    const { runId } = await w.handoff.register(pr1);

    await w.host.runtime.wait(runId);

    expect(w.handoff.status(runId)).toEqual({ status: "completed", outcome: "stopped" });
  });

  it("refuses a run id the host does not know", () => {
    const w = world();

    expect(() => w.handoff.status("no-such-run")).toThrow("no run no-such-run");
  });
});

describe("handoffRef binding", () => {
  it("an unbound ref throws handoff not bound", async () => {
    const handoff = handoffRef(shepherdFixture().routes.shepherd!);

    await expect(handoff.register(pr1)).rejects.toThrow(HandoffNotBoundError);
    expect(() => handoff.status("run")).toThrow("handoff not bound");
  });

  it("host.close() unbinds the ref the host bound", async () => {
    const w = world({ frozen: true });
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    const { runId } = await w.handoff.register(pr1);

    w.host.close();
    hosts.splice(hosts.indexOf(w.host), 1);

    expect(() => w.handoff.status(runId)).toThrow(HandoffNotBoundError);
  });

  it("an unbind from an earlier host leaves a later binding in place", () => {
    const handoff = handoffRef(shepherdFixture().routes.shepherd!);
    const first = world().host;
    const second = world().host;
    const unbindFirst = handoff.bind(first);
    handoff.bind(second);

    unbindFirst();

    expect(() => handoff.status("no-such-run")).toThrow("no run no-such-run");
  });
});
