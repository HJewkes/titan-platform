import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSha, successRun } from "@titan-design/github";
import { silentLogger } from "@titan-design/daemon";
import type { GateResolver } from "@titan-design/hitl";
import { WorkflowRuntime, type StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { startFactoryServer } from "../serve.js";
import { factoryContext } from "../registry.js";
import { TEST_BRIEF } from "../test-support/brief.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import { CARRIED_MERGE_STEP } from "./diverged-merge.js";
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
async function recorded(dbPath: string, prs: number[], base?: string): Promise<string[]> {
  const first = deploy(dbPath, build(false));
  const ids = prs.map((pr) => first.host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: String(pr), branch: branchOf(pr), policy: JSON.stringify(OWNER_GATE_POLICY), task: "demo/T-1" }));
  for (const id of ids) await vi.waitFor(() => expect(first.host.runtime.status(id)?.stepResults).toHaveProperty(["ci-wait:0"]));
  const store = first.routes.shepherd!.store.get();
  prs.forEach((pr, i) => store.register({ repo: REPO, pr, task: "demo/T-1", implementer: "impl-a", kind: "feature", branch: branchOf(pr), runId: ids[i]!, policy: OWNER_GATE_POLICY, ...(base !== undefined && { base }) }));
  first.host.close();
  return ids;
}

interface Parked {
  next: Deploy;
  dbPath: string;
  oldRunIds: string[];
}

/** Registered runs parked by strictReplay when build N+1 adopts them. */
async function parkedRuns(prs: number[] = [1], prState: "open" | "closed" = "open", base?: string): Promise<Parked> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "tp2697b-")), "factory.db");
  const oldRunIds = await recorded(dbPath, prs, base);
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

  it("keeps a diverged run whose owner gate is pending, so the gate is neither cancelled nor lost", async () => {
    const { next, oldRunIds } = await parkedRuns();
    const runId = oldRunIds[0]!;
    const gateId = `${runId}/approve-merge`;
    next.host.gates.create({ id: gateId, prompt: `Merge PR #1 in ${REPO} at head ${HEAD_B}?`, ...TEST_BRIEF });

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.restarted).toEqual([]);
    expect(sweep.kept).toEqual([{ runId, gateId }]);
    expect(next.host.gates.get(gateId)?.status).toBe("pending");
    expect(next.routes.shepherd!.store.get().byRun(runId)).toBeDefined();
    expect(next.host.runtime.status(runId)?.status).toBe("recovery_required");
  });

  it("restarts nothing on a second sweep", async () => {
    const { next } = await parkedRuns();
    await restartDivergedRuns(ctxOf(next));

    const again = await restartDivergedRuns(ctxOf(next));

    expect(again).toEqual({ restarted: [], ended: [], closed: [], kept: [], merged: [], errors: [] });
  });

  it("cancels a diverged run whose pull request closed and starts no new run", async () => {
    const { next, oldRunIds } = await parkedRuns([1], "closed");

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.restarted).toEqual([]);
    expect(sweep.ended).toEqual([{ runId: oldRunIds[0], reason: "replay diverged; PR closed" }]);
    await next.host.adopt();
    expect((await next.host.runtime.wait(oldRunIds[0]!)).status).toBe("cancelled");
  });

  it("ends a diverged run with a step in flight, PR closed, as cancelled in one sweep, and no adopt replays it", async () => {
    const { next, oldRunIds } = await parkedRuns([1], "closed");
    const runId = oldRunIds[0]!;
    expect(Object.keys(next.host.runtime.status(runId)!.activeSteps)).not.toEqual([]);

    const sweep = await restartDivergedRuns(ctxOf(next));
    const adopted = await next.host.adopt();

    expect(sweep.ended).toEqual([{ runId, reason: "replay diverged; PR closed" }]);
    expect(next.host.runtime.status(runId)).toMatchObject({ status: "cancelled", error: "replay diverged; PR closed", activeSteps: {} });
    expect(adopted).not.toContain(runId);
    expect(await restartDivergedRuns(ctxOf(next))).toEqual({ restarted: [], ended: [], closed: [], kept: [], merged: [], errors: [] });
  });

  it("ends the superseded run of an open PR with a step in flight as cancelled in the same sweep", async () => {
    const { next, oldRunIds } = await parkedRuns();
    const runId = oldRunIds[0]!;
    expect(Object.keys(next.host.runtime.status(runId)!.activeSteps)).not.toEqual([]);

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.restarted.map((restart) => restart.runId)).toEqual([runId]);
    expect(next.host.runtime.status(runId)).toMatchObject({ status: "cancelled", activeSteps: {} });
    expect(await next.host.adopt()).not.toContain(runId);
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

    expect(sweep).toEqual({ restarted: [], ended: [], closed: [], kept: [], merged: [], errors: [] });
  });

  it("leaves a diverged branch-only registration alone", async () => {
    const { next, oldRunIds } = await parkedRuns();
    const store = next.routes.shepherd!.store.get();
    vi.spyOn(store, "all").mockReturnValue(store.all().map((known) => ({ ...known, pr: null })));

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep).toEqual({ restarted: [], ended: [], closed: [], kept: [], merged: [], errors: [] });
    expect(next.host.runtime.status(oldRunIds[0]!)?.status).toBe("recovery_required");
  });
});

const OWNER: GateResolver = { class: "owner-terminal", id: "owner", channel: "factory-cli" };
const landPrompt = (head: string, base = "main", table = "authority"): string => `Merge PR #1 in ${REPO} at head ${head} into ${base}? CI is green. Policy ${table}/MRG-OW: owner gate`;

interface Answered extends Parked {
  runId: string;
  gateId: string;
}

/** A diverged run the sweep kept for its land gate, then answered by `resolver` while it stays parked. */
async function answeredWhileParked(payload: Record<string, unknown> | undefined, prompt = landPrompt(HEAD_B), resolver = OWNER): Promise<Answered> {
  const parked = await parkedRuns();
  const runId = parked.oldRunIds[0]!;
  const gateId = `${runId}/approve-merge`;
  parked.next.host.gates.create({ id: gateId, prompt, ...TEST_BRIEF });
  expect((await restartDivergedRuns(ctxOf(parked.next))).kept).toEqual([{ runId, gateId }]);
  if (payload) parked.next.host.runtime.signal(runId, "approve-merge", payload, resolver);
  return { ...parked, runId, gateId };
}

/** The sweep restarted the parked run as before, merged nothing, and the new run asks again. */
async function restartedAndAsking({ next, runId }: Answered, sweep: Awaited<ReturnType<typeof restartDivergedRuns>>): Promise<void> {
  expect(sweep.merged).toEqual([]);
  expect(sweep.restarted.map((restart) => restart.runId)).toEqual([runId]);
  await next.host.adopt();
  await vi.waitFor(() => expect(next.host.gates.listPending().map((gate) => gate.id)).toContain(`${sweep.restarted[0]!.newRunId}/extra-ask`));
  expect(next.fake.merges).toEqual([]);
  expect(next.host.runtime.status(runId)?.status).toBe("cancelled");
}

describe("restartDivergedRuns on an owner answer given while the run was parked (TP-3918)", () => {
  it("A resolved merge on a kept diverged run with an unchanged head merges once", async () => {
    const { next, runId, gateId } = await answeredWhileParked({ decision: "merge", headSha: HEAD_B });

    const sweep = await restartDivergedRuns(ctxOf(next));
    const again = await restartDivergedRuns(ctxOf(next));

    expect(sweep.merged).toEqual([{ runId, gateId, headSha: HEAD_B, mergeSha: next.fake.pr(1).mergeSha }]);
    expect(sweep.restarted).toEqual([]);
    expect(next.fake.merges).toHaveLength(1);
    expect(next.fake.pr(1)).toMatchObject({ merged: true });
    expect(next.host.runtime.status(runId)).toMatchObject({ status: "cancelled", stepResults: { [CARRIED_MERGE_STEP]: { data: { gateId, headSha: HEAD_B, base: "main", resolvedBy: OWNER } } } });
    expect(again).toEqual({ restarted: [], ended: [], closed: [], kept: [], merged: [], errors: [] });
  });

  it("A moved head restarts and asks again, never sending a merge for the head the owner approved", async () => {
    const answered = await answeredWhileParked({ decision: "merge", headSha: HEAD_B });
    answered.next.fake.pushHead(1, fakeSha("head-c"));
    const merge = vi.spyOn(answered.next.routes.shepherd!.port, "merge");

    await restartedAndAsking(answered, await restartDivergedRuns(ctxOf(answered.next)));
    expect(merge).not.toHaveBeenCalled();
  });

  it("An abandon answer cancels the parked run and restarts it as before, merging nothing", async () => {
    const answered = await answeredWhileParked({ decision: "abandon", headSha: HEAD_B });

    await restartedAndAsking(answered, await restartDivergedRuns(ctxOf(answered.next)));
  });

  it("A pending (unanswered) gate stays kept and merges nothing", async () => {
    const { next, runId, gateId } = await answeredWhileParked(undefined);

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(sweep.kept).toEqual([{ runId, gateId }]);
    expect(sweep.merged).toEqual([]);
    expect(next.fake.merges).toEqual([]);
  });

  it("restarts as before when the approved head is behind its base on a strict repo", async () => {
    const answered = await answeredWhileParked({ decision: "merge", headSha: HEAD_B });
    answered.next.fake.pr(1).behind = true;

    await restartedAndAsking(answered, await restartDivergedRuns(ctxOf(answered.next)));
  });

  it("restarts as before when the approved head conflicts with its base", async () => {
    const answered = await answeredWhileParked({ decision: "merge", headSha: HEAD_B });
    answered.next.fake.pr(1).mergeableState = "dirty";

    await restartedAndAsking(answered, await restartDivergedRuns(ctxOf(answered.next)));
  });

  it("restarts as before when a required check is red at the approved head", async () => {
    const answered = await answeredWhileParked({ decision: "merge", headSha: HEAD_B });
    answered.next.fake.onGetPr = (pr) => answered.next.fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2, undefined, "failure")]);

    const sweep = await restartDivergedRuns(ctxOf(answered.next));

    expect(sweep.merged).toEqual([]);
    expect(sweep.restarted.map((restart) => restart.runId)).toEqual([answered.runId]);
    expect(answered.next.fake.merges).toEqual([]);
  });

  it("restarts as before when the merge answer came from a resolver that is not the owner", async () => {
    const answered = await answeredWhileParked({ decision: "merge", headSha: HEAD_B });
    const gates = answered.next.host.gates;
    const get = gates.get.bind(gates);
    const coordinator: GateResolver = { class: "coordinator", id: "coord", channel: "factory-cli" };
    vi.spyOn(gates, "get").mockImplementation((id) => (id === answered.gateId ? { ...get(id)!, resolvedBy: coordinator } : get(id)));

    await restartedAndAsking(answered, await restartDivergedRuns(ctxOf(answered.next)));
  });

  it("restarts as before when the run already read the merge answer before it was parked", async () => {
    const answered = await answeredWhileParked({ decision: "merge", headSha: HEAD_B });
    const run = answered.next.host.runtime.status(answered.runId)!;
    const read = { stepId: "approve-merge", iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: "merge", headSha: HEAD_B } };
    vi.spyOn(answered.next.host.runtime, "status").mockImplementation((id) => (id === answered.runId ? { ...run, stepResults: { ...run.stepResults, "approve-merge": read } } : undefined));

    const sweep = await restartDivergedRuns(ctxOf(answered.next));

    expect(sweep.merged).toEqual([]);
    expect(answered.next.fake.merges).toEqual([]);
  });

  it("restarts as before when the approved gate named another base", async () => {
    const answered = await answeredWhileParked({ decision: "merge", headSha: HEAD_B }, landPrompt(HEAD_B, "release"));

    await restartedAndAsking(answered, await restartDivergedRuns(ctxOf(answered.next)));
  });

  it("restarts as before when the merge answer is on an escalation that shares the approve-merge step", async () => {
    const answered = await answeredWhileParked({ decision: "merge", headSha: HEAD_B }, landPrompt(HEAD_B, "main", "shepherd-route"));

    await restartedAndAsking(answered, await restartDivergedRuns(ctxOf(answered.next)));
  });
});

describe("restartDivergedRuns reclassification", () => {
  it("holds a restarted run on a policy path g10-adversary, as a live register would", async () => {
    const { next, oldRunIds } = await parkedRuns();
    next.fake.prFiles.set(1, [{ path: "products/factory/src/shepherd/g10-x.ts", status: "modified", additions: 10, deletions: 0 }]);

    const sweep = await restartDivergedRuns(ctxOf(next));

    const restarted = next.routes.shepherd!.store.get().byRun(sweep.restarted[0]!.newRunId);
    expect(sweep.restarted[0]!.runId).toBe(oldRunIds[0]);
    expect(restarted?.holdReason).toBe("g10-adversary: policy touch");
  });

  it("classes a restarted run at the head the sweep read, not the last read head it was seeded with", async () => {
    const { next } = await parkedRuns([1], "open", "main");
    const heads: Array<string | undefined> = [];
    next.routes.shepherd!.prFiles = async (target) => (heads.push(target.head), []);

    await restartDivergedRuns(ctxOf(next));

    expect(heads).not.toContain(HEAD_A);
    expect(heads).toContain(HEAD_B);
  });

  it("holds a restarted run g10-adversary when classing it throws, so it is not left unclassified", async () => {
    const { next } = await parkedRuns();
    const store = next.routes.shepherd!.store.get();
    next.fake.prFiles.set(1, [{ path: "products/factory/src/shepherd/g10-x.ts", status: "modified", additions: 10, deletions: 0 }]);
    vi.spyOn(store, "changeMark").mockImplementation(() => {
      throw new Error("store unreadable");
    });
    const unclassed = vi.spyOn(store, "holdUnlessAdversary").mockImplementationOnce(() => {
      throw new Error("store unreadable");
    });

    const sweep = await restartDivergedRuns(ctxOf(next));

    expect(unclassed).toHaveBeenCalledTimes(2);
    expect(sweep.errors).toHaveLength(1);
    expect(store.byRun(sweep.restarted[0]!.newRunId)?.holdReason).toMatch(/^g10-adversary/);
  });

  it("acts on no run once the server is closing", async () => {
    const { next, oldRunIds } = await parkedRuns();

    const sweep = await restartDivergedRuns(ctxOf(next), () => true);

    expect(sweep).toEqual({ restarted: [], ended: [], closed: [], kept: [], merged: [], errors: [] });
    expect(next.host.runtime.status(oldRunIds[0]!)?.status).toBe("recovery_required");
  });
});

describe("serve's adoption sweep", () => {
  it("still adopts when the diverged sweep throws outside its per-run guard", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp3186-")), "factory.db");
    const [runId] = await recorded(dbPath, [1]);
    const next = deploy(dbPath, build(false));
    next.host.close();
    const ref = next.routes.shepherd!.store;
    const bound = ref.get.bind(ref);
    vi.spyOn(ref, "get").mockImplementation(() => Object.assign(Object.create(bound()), { all: () => { throw new Error("store unreadable"); } }));
    const info: unknown[] = [];
    const warn: unknown[] = [];
    const logger = { ...silentLogger, info: (_fields: unknown, msg?: unknown) => void info.push(msg), warn: (_fields: unknown, msg?: unknown) => void warn.push(msg) };

    const server = await startFactoryServer({ dbPath, workflows: [build(false)], routes: next.routes, port: 0, logger, gatePollMs: 5, github: { status: () => "ok", refresh: async () => undefined } });
    closers.push(() => server.close());

    expect(warn).toContain("the replay-diverged sweep failed; adoption goes on without it");
    expect(info).toContain("adopted runs");
    expect(runId).toBeDefined();
  });

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
  it("names a closed-PR diverged run its sweep could not cancel in /health, for the deploy watch (TP-3220)", async () => {
    const { next, dbPath, oldRunIds } = await parkedRuns([1], "closed");
    next.host.close();
    const failingCancel = vi.spyOn(WorkflowRuntime.prototype, "cancel").mockImplementation(() => {
      throw new Error("store unreadable");
    });

    const server = await startFactoryServer({ dbPath, workflows: [build(true)], routes: next.routes, port: 0, logger: silentLogger, gatePollMs: 5, github: { status: () => "ok", refresh: async () => undefined } });
    closers.push(() => server.close());
    const health = z.object({ recoveryRequired: z.array(z.string()), recoveryPrClosed: z.array(z.string()), recoveryReplayDiverged: z.array(z.string()) }).parse(await (await fetch(`http://127.0.0.1:${server.port}/health`)).json());
    failingCancel.mockRestore();

    expect(health.recoveryRequired).toEqual(oldRunIds);
    expect(health.recoveryPrClosed).toEqual(oldRunIds);
    expect(health.recoveryReplayDiverged).toEqual(oldRunIds);
  });

  it("lists each run its sweep restarted with the successor in /health, for the deploy watch to report (TP-3889)", async () => {
    const { next, dbPath, oldRunIds } = await parkedRuns();
    next.host.close();

    const server = await startFactoryServer({ dbPath, workflows: [build(true)], routes: next.routes, port: 0, logger: silentLogger, gatePollMs: 5, github: { status: () => "ok", refresh: async () => undefined } });
    closers.push(() => server.close());
    const health = z.object({ divergedRestarts: z.array(z.object({ runId: z.string(), newRunId: z.string() })) }).parse(await (await fetch(`http://127.0.0.1:${server.port}/health`)).json());

    const successor = next.routes.shepherd!.store.get().all()[0]!.runId;
    expect(health.divergedRestarts).toEqual([{ runId: oldRunIds[0], newRunId: successor }]);
  });
});
