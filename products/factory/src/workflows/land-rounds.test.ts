import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { RoutedStepInput, StepRoute, WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { GATE_EVERYTHING_RULE, gateEverything, type GatePolicy } from "../gate-policy.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { crashAt } from "../test-support/crash.js";
import { H1, REPO, gateId, gateOpened, spaceUpdates } from "../test-support/land.js";
import { LAND_STEPS, MAX_UPDATE_CYCLES, MAX_UPDATE_RETRIES, land, landRoutes, type LandOptions, type LandOutcome } from "./land.js";
import { OWNER } from "../test-support/resolver.js";

const H2 = fakeSha("head2");
const ALLOW_RULE = { table: "test-table", rowId: "MRG-TEST", version: 3 };
const allowMerges: GatePolicy = { decide: () => ({ outcome: "allow", rule: ALLOW_RULE, reason: "reviewer verdict MERGE at this head" }) };
const denyMerges: GatePolicy = { decide: () => ({ outcome: "deny", rule: GATE_EVERYTHING_RULE, reason: "frozen" }) };

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

type Body = (ctx: WorkflowContext, fake: FakeGitHub, outcomes: LandOutcome[]) => Promise<void>;

interface RoundsOptions {
  redOnH1?: boolean;
  routes?: (routes: StepRoute[]) => StepRoute[];
}

/** A fake PR whose required check fails on H1 and passes on every other head, and a workflow running `body`. */
function roundsWorld(body: Body, options: RoundsOptions = {}) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  const red = (sha: string) => options.redOnH1 === true && sha === H1;
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, red(pr.headSha) ? "failure" : "success"), successRun("dag-check", 2)]);
  let clock = 0;
  spaceUpdates(fake, (ms) => void (clock += ms));
  const routes = landRoutes({ port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms) });
  const outcomes: LandOutcome[] = [];
  const workflow = defineWorkflow({ name: "land-rounds", steps: LAND_STEPS, run: (ctx) => body(ctx, fake, outcomes) });
  return { fake, outcomes, workflow, routes: options.routes?.(routes) ?? routes };
}

function roundsHost(body: Body, options: RoundsOptions = {}): { host: FactoryHost; fake: FakeGitHub; outcomes: LandOutcome[] } {
  const { fake, outcomes, workflow, routes } = roundsWorld(body, options);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, outcomes };
}

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-land-rounds-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

/** An allowing policy that records the head of every decision and runs `after` once it has decided. */
function allowAt(heads: (string | undefined)[], after: () => void = () => undefined): GatePolicy {
  return { decide: (_action, target) => (heads.push(target?.headSha), after(), allowMerges.decide("merge")) };
}

function once(policy: GatePolicy, extra: Partial<LandOptions> = {}): Body {
  return async (ctx, _fake, outcomes) => void outcomes.push(await land(ctx, { repo: REPO, pr: 1 }, { policy, ...extra }));
}

function stepIds(host: FactoryHost, runId: string): string[] {
  return Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
}

describe("land rounds", () => {
  it("re-entered for a new head, polls CI fresh under step ids that name the round", async () => {
    const body: Body = async (ctx, fake, outcomes) => {
      outcomes.push(await land(ctx, { repo: REPO, pr: 1 }, { policy: allowMerges }));
      if (fake.pr(1).headSha === H1) fake.pushHead(1, H2);
      outcomes.push(await land(ctx, { repo: REPO, pr: 1, round: 1 }, { policy: allowMerges }));
    };
    const { host, outcomes } = roundsHost(body, { redOnH1: true });

    const run = await host.runtime.wait(host.runtime.start("land-rounds"));

    expect(run.status).toBe("completed");
    expect(outcomes.map((outcome) => [outcome.kind, outcome.headSha])).toEqual([["ci-failed", H1], ["merged", H2]]);
    expect(stepIds(host, run.id)).toEqual(["land-rules", "ci-wait:0", "land-rules:r1", "ci-wait:r1:0", "merge-policy:r1:0", "ci-wait:r1:1", "base-check:r1:0", "merge:r1:0"]);
  });

  it("asks afresh in a later round instead of replaying the earlier round's approve-merge answer", async () => {
    const body: Body = async (ctx, _fake, outcomes) => {
      outcomes.push(await land(ctx, { repo: REPO, pr: 1 }, { policy: gateEverything }));
      outcomes.push(await land(ctx, { repo: REPO, pr: 1, round: 1 }, { policy: gateEverything }));
    };
    const { host, fake, outcomes } = roundsHost(body);
    const runId = host.runtime.start("land-rounds");
    await gateOpened(host, gateId(runId, "approve-merge"));
    host.runtime.signal(runId, "approve-merge", { decision: "abandon", headSha: H1 }, OWNER);

    await gateOpened(host, gateId(runId, "approve-merge", 1));
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await host.runtime.wait(runId);

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["stopped", "merged"]);
    expect(fake.effects.merge).toBe(1);
  });

  it("refuses a round that is not a non-negative integer", async () => {
    const { host } = roundsHost(async (ctx) => void (await land(ctx, { repo: REPO, pr: 1, round: -1 }, { policy: gateEverything })));

    const run = await host.runtime.wait(host.runtime.start("land-rounds"));

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("round must be a non-negative integer") });
  });

  it("refuses a fractional round", async () => {
    const { host } = roundsHost(async (ctx) => void (await land(ctx, { repo: REPO, pr: 1, round: 1.5 }, { policy: gateEverything })));

    const run = await host.runtime.wait(host.runtime.start("land-rounds"));

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("got 1.5") });
  });
});

describe("land merge policy", () => {
  it("on allow, merges with no hitl gate and records the policy trace and the caller's evidence", async () => {
    const seen: unknown[] = [];
    const allowEvidence: LandOptions["allowEvidence"] = (merge) => (seen.push(merge), { reviewer: "reviewer-1", verdictHead: merge.headSha });
    const { host, fake } = roundsHost(once(allowMerges, { allowEvidence }));

    const run = await host.runtime.wait(host.runtime.start("land-rounds"));
    const record = host.runtime.status(run.id)!.stepResults["merge-policy:0:0"]!;

    expect(run.status).toBe("completed");
    expect(fake.effects.merge).toBe(1);
    expect(host.gates.get(gateId(run.id, "approve-merge"))).toBeUndefined();
    expect(stepIds(host, run.id)).not.toContain("approve-merge");
    expect(seen).toEqual([{ repo: REPO, pr: 1, headSha: H1, decision: allowMerges.decide("merge") }]);
    expect(record.data).toMatchObject({
      result: { outcome: "allow", headSha: H1, rule: ALLOW_RULE },
      allowEvidence: { reviewer: "reviewer-1", verdictHead: H1 },
      "titan.trace.gates": [{ gateKind: "policy", verdict: "allow", decidedBy: "policy:test-table", policyRule: ALLOW_RULE, reason: "reviewer verdict MERGE at this head" }],
    });
    expect(JSON.parse(record.output!)).toMatchObject({ kind: "land.merge-policy", traceId: run.id });
  });

  it("on allow with no evidence hook, still records the policy trace with empty evidence", async () => {
    const { host } = roundsHost(once(allowMerges));

    const run = await host.runtime.wait(host.runtime.start("land-rounds"));

    expect(host.runtime.status(run.id)!.stepResults["merge-policy:0:0"]!.data).toMatchObject({ allowEvidence: {}, "titan.trace.gates": [{ verdict: "allow" }] });
  });

  it("on gate, records the gate decision, opens approve-merge, and merges only after the owner answers", async () => {
    const hooked: unknown[] = [];
    const { host, fake } = roundsHost(once(gateEverything, { allowEvidence: (merge) => (hooked.push(merge), {}) }));
    const runId = host.runtime.start("land-rounds");

    await gateOpened(host, gateId(runId, "approve-merge"));
    const mergesBeforeAnswer = fake.effects.merge;
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await host.runtime.wait(runId);

    expect(mergesBeforeAnswer).toBe(0);
    expect(fake.effects.merge).toBe(1);
    const record = host.runtime.status(runId)!.stepResults["merge-policy:0:0"]!.data;
    expect(record).toMatchObject({ result: { outcome: "gate", headSha: H1, rule: GATE_EVERYTHING_RULE } });
    expect(record).not.toHaveProperty("allowEvidence");
    expect(hooked).toEqual([]);
  });

  it("on deny, records the denial and stops merge-denied with no gate and no merge", async () => {
    const { host, fake, outcomes } = roundsHost(once(denyMerges));

    const run = await host.runtime.wait(host.runtime.start("land-rounds"));

    expect(outcomes.at(-1)).toMatchObject({ kind: "stopped", reason: "merge-denied", detail: "frozen" });
    expect(host.gates.listPending()).toEqual([]);
    expect(stepIds(host, run.id)).toEqual(["land-rules", "ci-wait:0", "merge-policy:0"]);
    expect(host.runtime.status(run.id)!.stepResults["merge-policy:0:0"]!.data).toMatchObject({ result: { outcome: "deny", headSha: H1 } });
    expect(fake.calls).not.toContain("merge");
  });

  it("on replay after a crash, reuses the recorded gate decision even though the policy now allows", async () => {
    let policy: GatePolicy = gateEverything;
    const flipping: GatePolicy = { decide: (action, target) => policy.decide(action, target) };
    const body: Body = async (ctx, _fake, outcomes) => {
      outcomes.push(await land(ctx, { repo: REPO, pr: 1 }, { policy: flipping }));
      if (outcomes.at(-1)!.kind === "stopped") outcomes.push(await land(ctx, { repo: REPO, pr: 1, round: 1 }, { policy: flipping }));
    };
    const { fake, outcomes, workflow, routes } = roundsWorld(body);
    const crash = crashAt({ dbPath: dbFile(), workflows: [workflow], routes, hangAt: "land-rules:r1" });
    const runId = crash.crashed.runtime.start("land-rounds");
    await gateOpened(crash.crashed, gateId(runId, "approve-merge"));
    crash.crashed.runtime.signal(runId, "approve-merge", { decision: "abandon", headSha: H1 }, OWNER);
    await crash.reached;

    policy = allowMerges;
    const survivor = crash.takeOver();
    await survivor.runtime.hydrate();
    await vi.waitFor(() => expect(survivor.runtime.status(runId)?.status).toMatch(/completed|failed|recovery_required/));
    const ids = stepIds(survivor, runId);
    crash.dispose();

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["stopped", "stopped", "merged"]);
    expect(ids).not.toContain("merge:0");
    expect(ids).toContain("merge:r1:0");
    expect(fake.effects.merge).toBe(1);
  });

  it("after an update-branch on an allow path, merges only on a decision recorded for the new head", async () => {
    const heads: (string | undefined)[] = [];
    const world: { fake: FakeGitHub; host: FactoryHost; outcomes: LandOutcome[] } = roundsHost(once(allowAt(heads, () => void (heads.length === 1 && (world.fake.pr(1).behind = true)))));
    const fake = world.fake;

    const run = await world.host.runtime.wait(world.host.runtime.start("land-rounds"));
    const newHead = fake.pr(1).headSha;
    const results = world.host.runtime.status(run.id)!.stepResults;

    expect(run.status).toBe("completed");
    expect(newHead).not.toBe(H1);
    expect(heads).toEqual([H1, newHead]);
    expect(results["merge-policy:1:0"]!.data).toMatchObject({ result: { outcome: "allow", headSha: newHead } });
    expect(results["merge:0:0"]!.data).toMatchObject({ result: { done: true } });
    expect(fake.calls.filter((call) => call === "merge")).toHaveLength(1);
    expect(world.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: newHead });
  });

  it(`retries once the policy-allowed heads have spent ${MAX_UPDATE_CYCLES} updates, and merges without a gate when the retry lands`, async () => {
    const world: { fake: FakeGitHub; host: FactoryHost; outcomes: LandOutcome[] } = roundsHost(
      once(allowAt([], () => void (world.fake.pr(1).behind = world.fake.effects.updateBranch <= MAX_UPDATE_CYCLES))),
    );
    const runId = world.host.runtime.start("land-rounds");

    const run = await world.host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(world.fake.effects).toMatchObject({ updateBranch: MAX_UPDATE_CYCLES + 1, merge: 1 });
    expect(stepIds(world.host, runId)).toContain("update-backoff:0");
    expect(world.host.gates.get(gateId(runId, "stuck-behind"))).toBeUndefined();
    expect(world.outcomes.at(-1)).toMatchObject({ kind: "merged" });
  });

  it(`gives a human approval a fresh ${MAX_UPDATE_CYCLES} updates before stuck-behind`, async () => {
    let racing = false;
    const world: { fake: FakeGitHub; host: FactoryHost; outcomes: LandOutcome[] } = roundsHost(once(gateEverything));
    const green = world.fake.onGetPr!;
    world.fake.onGetPr = (pr, reads) => (green(pr, reads), racing && (pr.behind = true));
    world.fake.pr(1).behind = true;
    const runId = world.host.runtime.start("land-rounds");

    await gateOpened(world.host, gateId(runId, "approve-merge"));
    racing = true;
    world.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: world.fake.pr(1).headSha }, OWNER);
    await gateOpened(world.host, gateId(runId, "stuck-behind"));
    world.host.runtime.signal(runId, "stuck-behind", { decision: "abandon" }, OWNER);
    await world.host.runtime.wait(runId);

    expect(world.fake.effects.updateBranch).toBe(1 + MAX_UPDATE_CYCLES + MAX_UPDATE_RETRIES);
    expect(world.fake.effects.merge).toBe(0);
  });

  it("keeps a human's merge approval across a retry that lands, so nobody is asked again", async () => {
    let racing = false;
    const world: { fake: FakeGitHub; host: FactoryHost; outcomes: LandOutcome[] } = roundsHost(once(gateEverything));
    const green = world.fake.onGetPr!;
    world.fake.onGetPr = (pr, reads) => (green(pr, reads), (pr.behind = racing && world.fake.effects.updateBranch < 1 + MAX_UPDATE_CYCLES + 1));
    world.fake.pr(1).behind = true;
    const runId = world.host.runtime.start("land-rounds");

    await gateOpened(world.host, gateId(runId, "approve-merge"));
    racing = true;
    world.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: world.fake.pr(1).headSha }, OWNER);
    const run = await world.host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(stepIds(world.host, runId)).toContain("update-backoff:0");
    expect(world.host.gates.get(gateId(runId, "approve-merge", 1))).toBeUndefined();
    expect(world.fake.effects.merge).toBe(1);
    expect(world.outcomes.at(-1)).toMatchObject({ kind: "merged" });
  });

  it("fails the run when the recorded decision names a head other than the one CI reported", async () => {
    const otherHead = (routes: StepRoute[]) =>
      routes.map((route) => (route.match !== "merge-policy" ? route : { ...route, runner: { run: (input: RoutedStepInput) => route.runner.run({ ...input, prompt: input.prompt.replace(H1, H2) }) } }));
    const { host, fake } = roundsHost(once(allowMerges), { routes: otherHead });

    const run = await host.runtime.wait(host.runtime.start("land-rounds"));

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining(`merge-policy recorded head ${H2}, expected ${H1}`) });
    expect(fake.effects.merge).toBe(0);
  });
});
