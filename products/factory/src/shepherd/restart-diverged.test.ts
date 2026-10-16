import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSha } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import type { Registered } from "./commands.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { SHEPHERD_WORKFLOW } from "./services.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const HEAD_B = H1;
const HEAD_A = fakeSha("head-a");
const HEAD_C = fakeSha("head-c");
const STEPS = [
  { id: "ci-wait", kind: "dispatch" },
  { id: "park-here", kind: "dispatch" },
  { id: "extra-ask", kind: "assisted" },
] as const;

/** Build N reads CI then waits; build N+1 asks a question before the recorded ci-wait. */
function build(asksFirst: boolean): WorkflowDefinition {
  return defineWorkflow({
    name: SHEPHERD_WORKFLOW,
    steps: STEPS,
    run: async (ctx) => {
      if (asksFirst) {
        const brief = { summary: "A question the old build never asked.", evidenceRef: "$ gh pr view 1" };
        await ctx.assisted("extra-ask", "Ask?", { schema: z.object({ ok: z.literal(true) }), brief });
      }
      await ctx.dispatch("ci-wait", "ci-wait");
      await ctx.dispatch("park-here", "park-here");
    },
  });
}

const stubRoutes: StepRoute[] = [
  { match: "ci-wait", onRestart: "repeat", runner: { run: () => Promise.resolve({ ok: true, output: JSON.stringify({ result: { headSha: HEAD_A } }) }) } },
  { match: "park-here", onRestart: "repeat", runner: { run: () => new Promise(() => undefined) } },
];

interface Deploy extends ShepherdFixture {
  host: FactoryHost;
  routes: FactoryRoutes;
}

function deploy(dbPath: string, definition: WorkflowDefinition): Deploy {
  const fixture = shepherdFixture();
  const routes = Object.assign([...stubRoutes], { shepherd: fixture.routes.shepherd, database: fixture.routes.database, bindHost: fixture.routes.bindHost }) as FactoryRoutes;
  const host = openFactoryHost({ dbPath, workflows: [definition], routes, gatePollMs: 5 });
  hosts.push(host);
  return { ...fixture, routes, host };
}

interface Parked {
  next: Deploy;
  oldRunId: string;
}

/** A registered run recorded on build N, parked by strictReplay when build N+1 adopts it. */
async function parkedRun(prState: "open" | "closed" = "open"): Promise<Parked> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "tp2697-")), "factory.db");
  const first = deploy(dbPath, build(false));
  const oldRunId = first.host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "1", branch: BRANCH, policy: JSON.stringify(OWNER_GATE_POLICY), task: "demo/T-1" });
  await vi.waitFor(() => expect(first.host.runtime.status(oldRunId)?.stepResults).toHaveProperty(["ci-wait:0"]));
  first.routes.shepherd!.store.get().register({ repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a", kind: "feature", branch: BRANCH, runId: oldRunId, policy: OWNER_GATE_POLICY });
  first.host.close();
  const next = deploy(dbPath, build(true));
  next.fake.addPr({ headSha: HEAD_B, headRef: BRANCH, state: prState });
  await next.host.adopt();
  await next.host.runtime.wait(oldRunId);
  return { next, oldRunId };
}

async function register(next: Deploy, extra: object = {}): Promise<Registered> {
  const envelope = await callCommand<Registered>(next.host, next.routes, "shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a", ...extra });
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
}

describe("shepherd.register on a replay-diverged run", () => {
  it("restarts it, keeps the registration and seeds the last read head", async () => {
    const { next, oldRunId } = await parkedRun();
    expect(next.host.runtime.status(oldRunId)?.status).toBe("recovery_required");

    const again = await register(next);

    expect(again).toMatchObject({ created: true, previousRunId: oldRunId, previousStop: "replay-diverged", registration: { runId: again.runId, task: "demo/T-1", implementer: "impl-a", kind: "feature", headSha: HEAD_A } });
    await next.host.adopt();
    const old = await next.host.runtime.wait(oldRunId);
    expect(old.status).toBe("cancelled");
    expect(old.error).toMatch(/^superseded: replay diverged/);
  });

  it("stays cancelled after one more adoption", async () => {
    const { next, oldRunId } = await parkedRun();
    await register(next);

    await next.host.adopt();

    expect((await next.host.runtime.wait(oldRunId)).status).toBe("cancelled");
  });

  it("carries a gating hold and an owner hold to the new run", async () => {
    const { next, oldRunId } = await parkedRun();
    const store = next.routes.shepherd!.store.get();
    store.hold(oldRunId, "g10-review", "rev");
    store.hold(oldRunId, "owner-asked: wait for the owner");

    const again = await register(next);

    expect(again).toMatchObject({ created: true, previousRunId: oldRunId });
    expect(again.runId).not.toBe(oldRunId);
    expect(again.registration).toMatchObject({ holdReason: "g10-review", holdReviewer: "rev", ownerHold: { reason: "owner-asked: wait for the owner" } });
  });

  it("lets an explicit head win over the last read head", async () => {
    const { next, oldRunId } = await parkedRun();

    const again = await register(next, { head: HEAD_C });

    expect(again.created).toBe(true);
    expect(again.runId).not.toBe(oldRunId);
    expect(again.registration.headSha).toBe(HEAD_C);
  });

  it("leaves a closed pull request's run parked", async () => {
    const { next, oldRunId } = await parkedRun("closed");

    const again = await register(next);

    expect(again.created).toBe(false);
    expect(next.host.runtime.status(oldRunId)?.status).toBe("recovery_required");
  });

  it("revives a run the sweep cancelled for a closed PR once the PR reopens", async () => {
    const { next, oldRunId } = await parkedRun();
    next.host.runtime.cancel(oldRunId, "replay diverged; PR closed");
    await next.host.adopt();
    await next.host.runtime.wait(oldRunId);

    const again = await register(next);

    expect(again).toMatchObject({ created: true, previousRunId: oldRunId, registration: { runId: again.runId, headSha: HEAD_A } });
  });

  it("leaves a run cancelled for another reason", async () => {
    const { next, oldRunId } = await parkedRun();
    next.host.runtime.cancel(oldRunId, "owner stopped it");
    await next.host.adopt();
    await next.host.runtime.wait(oldRunId);

    const again = await register(next);

    expect(again).toMatchObject({ created: false, runId: oldRunId });
  });

  it("leaves a park that is not a replay divergence", async () => {
    const { next, oldRunId } = await parkedRun();
    const run = next.host.runtime.status(oldRunId)!;
    vi.spyOn(next.host.runtime, "status").mockReturnValue({ ...run, error: "gate extra-ask is missing" });

    const again = await register(next);

    expect(again).toMatchObject({ created: false, runId: oldRunId });
  });
});
