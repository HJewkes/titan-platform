import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSha } from "@titan-design/github";
import { silentLogger } from "@titan-design/daemon";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { startFactoryServer } from "../serve.js";
import { factoryContext } from "../registry.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import { restartDivergedRuns } from "./diverged-sweep.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { SHEPHERD_WORKFLOW } from "./services.js";

const hosts: FactoryHost[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await Promise.all(closers.splice(0).map((close) => close()));
});

const HEAD_B = H1;
const HEAD_A = fakeSha("head-a");
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

const branchOf = (pr: number): string => `${BRANCH}-${pr}`;
const ctxOf = (next: Deploy) => factoryContext(next.host, next.routes);

/** Registered runs recorded on build N, one per pull request number; nothing adopts them yet. */
async function recorded(dbPath: string, prs: number[]): Promise<string[]> {
  const first = deploy(dbPath, build(false));
  const ids = prs.map((pr) => first.host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: String(pr), branch: branchOf(pr), policy: JSON.stringify(OWNER_GATE_POLICY), task: "demo/T-1" }));
  for (const id of ids) await vi.waitFor(() => expect(first.host.runtime.status(id)?.stepResults).toHaveProperty(["ci-wait:0"]));
  const store = first.routes.shepherd!.store.get();
  prs.forEach((pr, i) => store.register({ repo: REPO, pr, task: "demo/T-1", implementer: "impl-a", kind: "feature", branch: branchOf(pr), runId: ids[i]!, policy: OWNER_GATE_POLICY }));
  first.host.close();
  return ids;
}

interface Parked {
  next: Deploy;
  dbPath: string;
  oldRunIds: string[];
}

/** Registered runs parked by strictReplay when build N+1 adopts them. */
async function parkedRuns(prs: number[] = [1], prState: "open" | "closed" = "open"): Promise<Parked> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "tp2697b-")), "factory.db");
  const oldRunIds = await recorded(dbPath, prs);
  const next = deploy(dbPath, build(true));
  prs.forEach((pr) => next.fake.addPr({ headSha: HEAD_B, headRef: branchOf(pr), state: prState }));
  await next.host.adopt();
  for (const id of oldRunIds) await next.host.runtime.wait(id);
  return { next, dbPath, oldRunIds };
}

describe("restartDivergedRuns", () => {
  it("restarts a diverged run at its registration, carrying task, implementer, kind, hold and last read head", async () => {
    const { next, oldRunIds } = await parkedRuns();
    const store = next.routes.shepherd!.store.get();
    store.hold(oldRunIds[0]!, "g10-review", "rev");

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.restarted).toHaveLength(1);
    const { runId, newRunId } = sweep.restarted[0]!;
    expect(runId).toBe(oldRunIds[0]);
    expect(store.byRun(newRunId)).toMatchObject({ task: "demo/T-1", implementer: "impl-a", kind: "feature", headSha: HEAD_A, holdReason: "g10-review", holdReviewer: "rev" });
    expect(store.byRun(runId)).toBeUndefined();
    await next.host.adopt();
    expect((await next.host.runtime.wait(runId)).status).toBe("cancelled");
  });

  it("restarts nothing on a second sweep", async () => {
    const { next } = await parkedRuns();
    await restartDivergedRuns(ctxOf(next));

    const again = await restartDivergedRuns(ctxOf(next));

    expect(again).toEqual({ restarted: [], ended: [], errors: [] });
  });

  it("cancels a diverged run whose pull request closed and starts no new run", async () => {
    const { next, oldRunIds } = await parkedRuns([1], "closed");

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.restarted).toEqual([]);
    expect(sweep.ended).toEqual([{ runId: oldRunIds[0], reason: "replay diverged; PR closed" }]);
    await next.host.adopt();
    expect((await next.host.runtime.wait(oldRunIds[0]!)).status).toBe("cancelled");
  });

  it("reports a run whose pull request cannot be read and still restarts the others", async () => {
    const { next, oldRunIds } = await parkedRuns([1, 2]);
    const port = next.routes.shepherd!.port;
    const getPr = port.getPr.bind(port);
    vi.spyOn(port, "getPr").mockImplementation((repo, pr) => (pr === 1 ? Promise.reject(new Error("rate limited")) : getPr(repo, pr)));

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.errors).toEqual([{ runId: oldRunIds[0], cause: "rate limited" }]);
    expect(sweep.restarted.map((r) => r.runId)).toEqual([oldRunIds[1]]);
    expect(next.host.runtime.status(oldRunIds[0]!)?.status).toBe("recovery_required");
  });

  it("leaves a park that is not a replay divergence", async () => {
    const { next, oldRunIds } = await parkedRuns();
    const run = next.host.runtime.status(oldRunIds[0]!)!;
    vi.spyOn(next.host.runtime, "status").mockReturnValue({ ...run, error: "gate extra-ask is missing" });

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep).toEqual({ restarted: [], ended: [], errors: [] });
  });

  it("leaves a diverged branch-only registration alone", async () => {
    const { next, oldRunIds } = await parkedRuns();
    const store = next.routes.shepherd!.store.get();
    vi.spyOn(store, "all").mockReturnValue(store.all().map((known) => ({ ...known, pr: null })));

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep).toEqual({ restarted: [], ended: [], errors: [] });
    expect(next.host.runtime.status(oldRunIds[0]!)?.status).toBe("recovery_required");
  });
});

describe("serve's adoption sweep", () => {
  it("restarts a run parked under an earlier build on the first tick", async () => {
    const { next, dbPath, oldRunIds } = await parkedRuns();
    next.host.close();
    const info: unknown[] = [];
    const logger = { ...silentLogger, info: (_fields: unknown, msg?: unknown) => void info.push(msg) };

    const server = await startFactoryServer({ dbPath, workflows: [build(true)], routes: next.routes, port: 0, logger, gatePollMs: 5, github: { status: () => "ok", refresh: async () => undefined } });
    closers.push(() => server.close());

    expect(info).toContain("restarted a replay-diverged run");
    expect(next.routes.shepherd!.store.get().all().map((known) => known.runId)).not.toContain(oldRunIds[0]);
  });
});
