import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cellTable } from "./digest.js";
import { PlannedSchema, RoundSummarySchema } from "./ports.js";
import { arRunSummary, arRunView, ideaRefs, projectMetric } from "./read-model.js";
import type { ArRunView } from "./read-model-types.js";
import { ArResultSchema, ideaId, OutcomeSchema, type Proposal } from "./schemas.js";
import { ArRunSummarySchema, ArRunViewSchema } from "./test-support/console-schemas.js";
import { FIXTURE_POLICY, THROUGHPUT_TARGET, fakeArPorts, fixtureRepo, proposal, removeFixture, scriptedPlanner, type FakeOptions, type FixtureRepo, type Policy } from "./test-support/fake-ports.js";
import { openTestHost, type TestHost } from "./test-support/host.js";
import { latch, stopOutcomes, until } from "./test-support/runs.js";
import { AUTORESEARCH_VALIDATE_WORKFLOW } from "./validate.js";
import { AUTORESEARCH_WORKFLOW } from "./workflow.js";

const CC = "cc_total_delta_pct";
const POLICY: Policy = {
  ...FIXTURE_POLICY,
  gates: ["gate_b", "gate_a"],
  mechanisms: { better: { metrics: { [CC]: -3 } }, "better-2": { metrics: { [CC]: -3 } }, flat: { micro: false } },
};

const hosts: TestHost[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  repos.splice(0).forEach(removeFixture);
});

const id = (mechanism: string) => ideaId(proposal(mechanism));

async function world(options: Partial<FakeOptions> = {}, policy: Policy = POLICY) {
  const repo = await fixtureRepo(policy);
  repos.push(repo);
  const ports = fakeArPorts(repo, policy, { planner: scriptedPlanner(["better", "better-2", "flat"]), ...options });
  const host = openTestHost(ports);
  hosts.push(host);
  return { repo, ports, host };
}

const CONFIG = { lanes: 2, rounds: 2, minPool: 0 };

async function finished(options: Partial<FakeOptions> = {}, policy: Policy = POLICY) {
  const { repo, ports, host } = await world(options, policy);
  const run = await host.runtime.wait(host.runtime.start(AUTORESEARCH_WORKFLOW, { target: "fixture", pin: repo.pin, config: JSON.stringify(CONFIG) }));
  return { repo, ports, host, run, view: arRunView(run)! };
}

const dispatchedOf = (run: WorkflowRun, stepId: string) => z.object({ result: z.unknown() }).parse(run.stepResults[`${stepId}:0`]!.data).result;
const summaryOf = (run: WorkflowRun, round: number) => RoundSummarySchema.parse(JSON.parse(run.stepResults[`ar-summary:${round}`]!.output!));
const ladderOf = (view: ArRunView, round: number, ideaId: string) => view.rounds[round - 1]!.ladders.find((ladder) => ladder.idea.id === ideaId)!;

describe("the run read model on a two-round fixture run", () => {
  it("parses with the console's run and summary schemas", async () => {
    const { run, view } = await finished();

    const parsed = ArRunViewSchema.parse(view);
    const summary = ArRunSummarySchema.parse(arRunSummary(run));

    expect(parsed.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(parsed.stopReason).toBe("rounds-exhausted");
    expect(summary).toMatchObject({ target: "fixture", phase: "p1", round: 2, rounds: 2, status: "completed", best: summaryOf(run, 2).best });
  });

  it("carries each recorded outcome whole, stamped with the round's σ", async () => {
    const { run, view } = await finished();
    const recorded = stopOutcomes(run).get(id("flat"))!;

    const { outcome } = ladderOf(view, 1, id("flat"));

    expect(outcome).toEqual({ ...recorded, sigma: summaryOf(run, 1).against.sigma });
    expect(Object.keys(outcome!)).toEqual(expect.arrayContaining(["against", "implementer", "lane", "fork", "l0", "usage", "micro"]));
  });

  it("names the planner that answered each round", async () => {
    const { run, view } = await finished();
    const planner = PlannedSchema.omit({ ops: true }).parse(dispatchedOf(run, "ar-plan:2"));

    expect(view.rounds[1]!.planner).toEqual(planner);
    expect(planner).toMatchObject({ agent: expect.any(String), mode: "resume", usage: { usd: 0.25 } });
  });

  it("lists the gates the baseline ran for an all-gate target, and none for a target without the rule", async () => {
    const { view } = await finished();

    expect(view.target.metric.allGate).toEqual(["gate_a", "gate_b"]);
    expect(view.target.metric.noOp).toEqual(["accepted_tasks"]);
    expect(projectMetric(THROUGHPUT_TARGET.metric, [])).toMatchObject({ direction: "max", allGate: [], noOp: ["requests_served"] });
  });

  it("names each eval's wall time as the console does", async () => {
    const { run, view } = await finished();
    const recorded = ArResultSchema.parse(dispatchedOf(run, `ar-eval:1/${id("better")}:r1`));

    const parsed = ArRunViewSchema.parse(view);

    expect(parsed.rounds[0]!.ladders.find((ladder) => ladder.idea.id === id("better"))!.evals[0]!.wallS).toBe(recorded.wall_s);
    expect(parsed.baseline.runs.map((result) => result.wallS)).toEqual(Array(6).fill(0));
  });

  it("shows a superseded winner stopped, and replays the registries and cells the archive received", async () => {
    const { run, view, ports } = await finished();
    const [superseded] = summaryOf(run, 1).superseded;

    expect(ladderOf(view, 1, superseded!).outcome).toMatchObject({ verdict: "stopped", reason: "superseded" });
    expect(view.registries.deadEnds.filter((entry) => entry.ideaId === superseded && entry.round === 1)).toHaveLength(1);
    expect(view.registries).toEqual(ports.calls.archives.at(-1)!.record.registries);
    expect(view.cells).toEqual(cellTable(ports.calls.archives.flatMap(({ record }) => record.evidence)));
  });
});

describe("a run still in flight", () => {
  it("has no best while one baseline eval is still running", async () => {
    const held = latch();
    const { repo, host } = await world({ beforeEval: (_ideaId, key) => (key.endsWith("-base-b1") ? held.opened : Promise.resolve()) });
    const runId = host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify(CONFIG) });
    const baselineDone = () => Object.keys(host.runtime.status(runId)!.stepResults).filter((key) => key.startsWith("ar-eval:base:")).length;
    await until(() => baselineDone() === 5, "five baseline evals");

    const summary = arRunSummary(host.runtime.status(runId)!);
    held.open();
    const done = arRunSummary(await host.runtime.wait(runId));

    expect(summary).toMatchObject({ best: null, round: 0, phase: "p1" });
    expect(done.best).not.toBeNull();
  });

  it("counts the round whose planner is still answering", async () => {
    const held = latch();
    const { repo, host } = await world({ beforePlan: (round) => (round === 2 ? held.opened : Promise.resolve()) });
    const runId = host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify(CONFIG) });
    await until(() => Object.keys(host.runtime.status(runId)?.activeSteps ?? {}).some((key) => key.startsWith("ar-plan:2")), "round 2's plan");

    const summary = arRunSummary(host.runtime.status(runId)!);
    held.open();
    await host.runtime.wait(runId);

    expect(summary.round).toBe(2);
  });

  it("counts what failed attempts of an in-flight step already spent", async () => {
    const { run } = await finished();
    const [first] = Object.keys(run.stepResults);
    const startedAt = "2026-10-21T00:00:00.000Z";
    const active = { kind: "legacy" as const, stepId: "ar-l0:3/i-000000000000", iterKey: "ar-l0:3/i-000000000000:0", attempt: 2, startedAt, priorUsage: { costUsd: 0.5 } };
    const priced: WorkflowRun = {
      ...run,
      stepResults: { ...run.stepResults, [first!]: { ...run.stepResults[first!]!, usage: { costUsd: 1.25 } } },
      activeSteps: { [active.iterKey]: active },
    };

    expect(arRunSummary(priced).spend).toBe(1.75);
  });
});

describe("ideas, looks and why a run stopped", () => {
  const LINEAGE: Policy = { ...POLICY, mechanisms: { "flat-a": { micro: false }, "flat-b": { micro: false }, "flat-c": { micro: false } } };

  it("counts a follow-up of a follow-up two parents deep", async () => {
    const chain: Proposal[] = [
      proposal("flat-a", { bold: true }),
      proposal("flat-b", { parent: id("flat-a"), source: "followup" }),
      proposal("flat-c", { parent: id("flat-b"), source: "followup" }),
    ];
    const { view } = await finished({ planner: ({ round }) => (round === 1 ? { add: chain } : { exempt: { bold: "test", followup: "test" } }) }, LINEAGE);

    const depths = Object.fromEntries(view.rounds[0]!.queue.map((idea) => [idea.mechanism, idea.lineageDepth]));

    expect(depths).toEqual({ "flat-a": 0, "flat-b": 1, "flat-c": 2 });
  });

  it("shows validator looks only in their own section", async () => {
    const { repo, host, run, view } = await finished();
    const head = summaryOf(run, 2).best.head;
    const look = await host.runtime.wait(host.runtime.start(AUTORESEARCH_VALIDATE_WORKFLOW, { parent: run.id, pin: repo.pin, head, look: "1" }));

    const { validator, ...rest } = arRunView(run, [look])!;

    expect(rest).toEqual(view);
    expect(validator!.maxLooks).toBe(2);
    expect(validator!.looks.map((entry) => Object.keys(entry).sort())).toEqual([["aggregate", "at", "look", "provenance", "sha", "usd"]]);
    expect(ArRunViewSchema.parse({ ...view, validator }).validator!.looks[0]!.sha).toBe(head);
  });

  it("diffs a requeued idea's latest ladder against the head its round started from", async () => {
    const { run } = await finished();
    const [superseded] = summaryOf(run, 1).superseded;
    const latest = OutcomeSchema.parse(JSON.parse(run.stepResults[`ar-stop:2/${superseded}`]!.output!));

    expect(ideaRefs(run, superseded!)).toEqual({ base: summaryOf(run, 1).best.head, head: latest.head });
    expect(ideaRefs(run, "i-ffffffffffff")).toBeUndefined();
  });

  it("names a thrown run's stop by its error code", async () => {
    const { run, view } = await finished({ planner: () => ({ add: [proposal("flat")] }) });

    expect(run.status).toBe("failed");
    expect(view.stopReason).toBe("planner-quota");
  });
});
