import { readFileSync } from "node:fs";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cellTable } from "./digest.js";
import { PlannedSchema, RoundSummarySchema, type SyncRequest } from "./ports.js";
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

/** `a` gains 4 pp and always wins first; `b` merges cleanly beside it, and with `a` in the tree `b-cancelled` loses its gain. */
const WINNERS: Policy = {
  ...FIXTURE_POLICY,
  mechanisms: { a: { metrics: { [CC]: -4 } }, b: { metrics: { [CC]: -3 } }, "b-cancelled": { metrics: { [CC]: -3 } } },
  interactions: { "a+b-cancelled": { metrics: { [CC]: 3.5 } } },
};
const PLANNER_FILES: Partial<Proposal> = { class: "planner-ranking", targets: ["src/planner/rank.py"] };
const winner = (mechanism: string) => proposal(mechanism, { bold: true, ...(mechanism.startsWith("b") ? PLANNER_FILES : {}) });
const winnerId = (mechanism: string) => ideaId(winner(mechanism));
/** Round r proposes `byRound[r - 1]`; later rounds propose nothing. */
const byRounds = (byRound: string[][]) => ({ round }: { round: number }) =>
  byRound[round - 1] ? { add: byRound[round - 1]!.map(winner), exempt: { followup: "test" } } : { exempt: { bold: "script ends", followup: "script ends" } };

async function winnersRun(byRound: string[][], config: object, options: Partial<FakeOptions> = {}) {
  const { repo, ports, host } = await world({ planner: byRounds(byRound), ...options }, WINNERS);
  const run = await host.runtime.wait(host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify({ lanes: 2, minPool: 0, ...config }) }));
  return { repo, ports, host, run, view: arRunView(run)! };
}

const ladderIn = (view: ArRunView, mechanism: string) => view.rounds[0]!.ladders.filter((ladder) => ladder.idea.id === winnerId(mechanism));

describe("G13a: later winners re-evaluated against the round's new head", () => {
  it("shows a re-eval reject once, as a rejected outcome carrying its re-eval against the first winner's head", async () => {
    const { run, view } = await winnersRun([["a", "b-cancelled"]], { rounds: 1 });
    const first = stopOutcomes(run).get(winnerId("a"))!;

    const [reeval] = view.rounds[0]!.reevals;
    const ladders = ladderIn(view, "b-cancelled");

    expect(reeval).toMatchObject({ ideaId: winnerId("b-cancelled"), decision: "rejected", vs: first.head });
    expect(reeval!.runs.map((result) => [typeof result.wallS, "wall_s" in result])).toEqual([["number", false], ["number", false], ["number", false]]);
    expect(ladders).toHaveLength(1);
    expect(ladders[0]!.outcome).toMatchObject({ verdict: "rejected", reeval: { vs: first.head, decision: "rejected" } });
    expect(view.cells.reduce((trials, cell) => trials + cell.trials, 0)).toBe(2);
  });

  it("shows a requeued re-eval as superseded, with the requeued decision in both places", async () => {
    const { repo, ports, host } = await world({ planner: byRounds([["a", "b"]]) }, WINNERS);
    delete ports.integrate;
    const run = await host.runtime.wait(host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify({ lanes: 2, rounds: 1, minPool: 0 }) }));
    const view = arRunView(run)!;

    expect(view.rounds[0]!.reevals.map((reeval) => [reeval.ideaId, reeval.decision])).toEqual([[winnerId("b"), "requeued"]]);
    expect(ladderIn(view, "b")[0]!.outcome).toMatchObject({ verdict: "stopped", reason: "superseded", reeval: { decision: "requeued" } });
  });

  it("lists every move of a round that kept two winners, beside the net move", async () => {
    const { repo, view } = await winnersRun([["a", "b"]], { rounds: 1 });
    const { moves, ratchet, reevals } = view.rounds[0]!;

    expect(moves.map((move) => [move.kind, move.ideaId])).toEqual([["ff", winnerId("a")], ["merge", winnerId("b")]]);
    expect(ratchet).toEqual({ from: repo.pin, to: reevals[0]!.merge });
    expect(ratchet).toEqual({ from: moves[0]!.from, to: moves[1]!.to });
  });
});

const syncMerged = (treeChanged: boolean) => async (input: SyncRequest) => ({ state: "merged" as const, merged: { from: input.head, to: input.head, main: input.head }, treeChanged });
const RUNGS = ["none", "L0", "L1", "L2", "L3"];

describe("G13: snapshots and syncs", () => {
  it("joins each cut with the trigger and round its cadence decided", async () => {
    const { run, view } = await winnersRun([["a"], ["b"]], { rounds: 2, snapshot: { keptIdeas: 1 } });
    const cut = z.object({ result: z.object({ tag: z.string(), branch: z.string(), logSha: z.string() }) }).parse(run.stepResults["ar-snapshot:1:0"]!.data).result;

    expect(view.snapshots).toEqual([{ k: 1, tag: cut.tag, sha: summaryOf(run, 1).best.head, branch: cut.branch, pr: 101, trigger: "kept", round: 1, logSha: cut.logSha }]);
  });

  it("shows the phase-end cut pending behind the open snapshot, which the run summary names", async () => {
    const { run, view } = await winnersRun([["a"], ["b"]], { rounds: 2, snapshot: { keptIdeas: 1 } });

    expect(view.snapshotPending).toEqual({ trigger: "phase-end" });
    expect(view.syncs.map((sync) => [sync.round, sync.pr, sync.state])).toEqual([[2, 101, "open"], ["end", 101, "open"]]);
    expect(arRunSummary(run).openSnapshot).toEqual({ k: 1, pr: 101 });
  });

  it("has nothing pending when the phase-end cut was made", async () => {
    const { run, view } = await winnersRun([["a"]], { rounds: 1, snapshot: { keptIdeas: 3 } });

    expect(view.snapshotPending).toBeNull();
    expect(view.snapshots.map((cut) => [cut.k, cut.round, cut.trigger])).toEqual([[1, "end", "phase-end"]]);
    expect(arRunSummary(run).openSnapshot).toEqual({ k: 1, pr: 101 });
  });

  it("counts each cut once after a failed attempt, under the round that made it", async () => {
    const snapshot = async (input: { k: number }, call: number) => {
      if (call === 1) throw new Error("[snapshot-fixture] the push was refused");
      return { k: input.k, tag: "refs/tags/ar/fixture/r/m1", sha: "s", branch: "refs/heads/autoresearch/fixture-snap/r/m1", pr: 7, logSha: "l" };
    };
    const { view } = await winnersRun([["a"], ["b"]], { rounds: 2, snapshot: { keptIdeas: 1 } }, { snapshot });

    expect(view.snapshots.map((cut) => [cut.k, cut.round, cut.pr])).toEqual([[1, 2, 7]]);
  });

  it("projects a changed-tree sync's re-measure under its sync only, never as a rung of any idea", async () => {
    const { run, view } = await winnersRun([["a"], ["b"]], { rounds: 2, snapshot: { keptIdeas: 1 } }, { sync: syncMerged(true) });

    const [sync] = view.syncs;
    const ladders = view.rounds.flatMap((round) => round.ladders);

    expect(sync).toMatchObject({ round: 2, pr: 101, state: "merged", treeChanged: true });
    const stepIds = Object.values(run.stepResults).map((result) => result.stepId);
    expect(sync!.runs).toEqual(["r1", "r2", "r3"].map((label) => expect.objectContaining({ wallS: ArResultSchema.parse(dispatchedOf(run, `ar-eval:sync-2:${label}`)).wall_s })));
    expect(ladders.flatMap((ladder) => ladder.evals)).toHaveLength(stepIds.filter((stepId) => /^ar-eval:\d+\/i-/.test(stepId)).length);
    expect(ladders.every((ladder) => RUNGS.includes(ladder.outcome!.rungReached))).toBe(true);
    expect(ArRunViewSchema.parse(view).syncs.map((entry) => [entry.round, entry.pr])).toEqual([[2, 101], ["end", 102]]);
    expect(arRunSummary(run).openSnapshot).toBeNull();
  });

  it("shows a held sync's gate unanswered, then answered with the owner's merge", async () => {
    const sync = async (input: SyncRequest) =>
      input.resolved ? { state: "merged" as const, merged: { from: input.head, to: input.resolved, main: input.resolved }, treeChanged: false } : { state: "merged" as const, conflict: ["src/config.json"] };
    const { repo, ports, host } = await world({ planner: byRounds([["a"]]), sync }, WINNERS);
    const runId = host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify({ lanes: 2, minPool: 0, rounds: 2, snapshot: { keptIdeas: 1 } }) });
    await until(() => host.runtime.status(runId)?.status === "paused", "the sync gate");

    const held = arRunView(host.runtime.status(runId)!)!.syncs;
    const resolved = ports.calls.sync[0]!.head;
    host.runtime.signal(runId, "ar-sync-gate:2", { resolved }, { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" });
    const run = await host.runtime.wait(runId);

    expect(held).toEqual([{ round: 2, pr: 101, state: "merged", conflict: ["src/config.json"], gate: { answered: false } }]);
    expect(arRunView(run)!.syncs[0]).toEqual({ round: 2, pr: 101, state: "merged", conflict: ["src/config.json"], merged: { from: resolved, to: resolved, main: resolved }, treeChanged: false, gate: { answered: true, resolved } });
    expect(arRunSummary(run).openSnapshot).toBeNull();
  });

  it("keeps the snapshot open while a held sync's gate waits for the owner", async () => {
    const sync = async () => ({ state: "merged" as const, frozen: ["src/gate/measure.py"] });
    const { repo, host } = await world({ planner: byRounds([["a"]]), sync }, WINNERS);
    const runId = host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify({ lanes: 2, minPool: 0, rounds: 2, snapshot: { keptIdeas: 1 } }) });
    await until(() => host.runtime.status(runId)?.status === "paused", "the sync gate");

    const paused = host.runtime.status(runId)!;

    expect(arRunView(paused)!.syncs.map((entry) => [entry.round, entry.state, entry.gate])).toEqual([[2, "merged", { answered: false }]]);
    expect(arRunSummary(paused).openSnapshot).toEqual({ k: 1, pr: 101 });
  });

  it("shows a held last sync with no gate, since the run's end opens none", async () => {
    const sync = async () => ({ state: "merged" as const, conflict: ["src/config.json"] });
    const { run, view } = await winnersRun([["a"]], { rounds: 1, snapshot: { keptIdeas: 1 } }, { sync });

    expect(run.status).toBe("completed");
    expect(view.syncs).toEqual([{ round: "end", pr: 101, state: "merged", conflict: ["src/config.json"] }]);
    expect(Object.keys(view.syncs[0]!)).not.toContain("gate");
  });

  it("shows a failed sync as open with its error, and the retry beside it as an ordinary sync", async () => {
    const sync = async (_input: SyncRequest, call: number) => {
      if (call === 1) throw new Error("[pin-fetch] git fetch origin failed in fixture-clone");
      return { state: "open" as const };
    };
    const { run, view } = await winnersRun([["a"], ["b"]], { rounds: 2, snapshot: { keptIdeas: 1 } }, { sync });

    expect(view.syncs).toEqual([
      { round: 2, pr: 101, state: "open", failed: "[pin-fetch] git fetch origin failed in fixture-clone" },
      { round: "end", pr: 101, state: "open" },
    ]);
    expect(ArRunViewSchema.parse(view).syncs[0]!.failed).toContain("[pin-fetch]");
    expect(arRunSummary(run).openSnapshot).toEqual({ k: 1, pr: 101 });
  });

  it("shows a failed last sync as open, the snapshot still open when the run ended", async () => {
    const sync = async () => Promise.reject(new Error("[sync-fixture] getPr answered 502"));
    const { run, view } = await winnersRun([["a"]], { rounds: 1, snapshot: { keptIdeas: 1 } }, { sync });

    expect(run.status).toBe("completed");
    expect(view.syncs).toEqual([{ round: "end", pr: 101, state: "open", failed: "[sync-fixture] getPr answered 502" }]);
    expect(arRunSummary(run).openSnapshot).toEqual({ k: 1, pr: 101 });
  });

  it("shows a sync that failed after the owner's answer as open, beside the conflict and the answered gate", async () => {
    const UNREACHABLE = "a".repeat(40);
    const sync = async (input: SyncRequest) => {
      if (input.resolved) throw new Error("[sync-fixture] the resolved merge was not on origin");
      return { state: "merged" as const, conflict: ["src/config.json"] };
    };
    const { repo, host } = await world({ planner: byRounds([["a"]]), sync }, WINNERS);
    const runId = host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify({ lanes: 2, minPool: 0, rounds: 2, snapshot: { keptIdeas: 1 } }) });
    await until(() => host.runtime.status(runId)?.status === "paused", "the sync gate");
    host.runtime.signal(runId, "ar-sync-gate:2", { resolved: UNREACHABLE }, { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" });
    const run = await host.runtime.wait(runId);

    expect(arRunView(run)!.syncs[0]).toEqual({
      round: 2, pr: 101, state: "open", conflict: ["src/config.json"], gate: { answered: true, resolved: UNREACHABLE }, failed: "[sync-fixture] the resolved merge was not on origin",
    });
    expect(arRunSummary(run).openSnapshot).toEqual({ k: 1, pr: 101 });
  });

  it("reopens nothing after a closed PR, and the next cut opens under the next k", async () => {
    const { run, view } = await winnersRun([["a"], ["b"]], { rounds: 2, snapshot: { keptIdeas: 1 } }, { sync: async () => ({ state: "closed" as const }) });

    expect(view.snapshots.map((cut) => [cut.k, cut.round])).toEqual([[1, 1], [2, 2], [3, "end"]]);
    expect(view.syncs.map((sync) => [sync.round, sync.pr, sync.state])).toEqual([[2, 101, "closed"], ["end", 102, "closed"]]);
    expect(arRunSummary(run).openSnapshot).toEqual({ k: 3, pr: 103 });
  });
});

describe("the console's G13 and G13a shapes", () => {
  it("parse the read model of a run that re-evaluated a winner and cut a snapshot", async () => {
    const { run, view } = await winnersRun([["a", "b"]], { rounds: 1, snapshot: { keptIdeas: 1 } });

    const parsed = ArRunViewSchema.parse(view);

    expect(parsed.rounds[0]!.reevals).toHaveLength(1);
    expect(parsed.rounds[0]!.moves).toHaveLength(2);
    expect(parsed.snapshots).toHaveLength(1);
    expect(ArRunSummarySchema.parse(arRunSummary(run)).openSnapshot).toEqual({ k: 1, pr: 101 });
  });

  it("read an old recorded run with every new section empty", () => {
    const run: WorkflowRun = JSON.parse(readFileSync(new URL("./test-support/fixtures/run-38ef0296.json", import.meta.url), "utf8"));
    const view = arRunView(run)!;

    expect(view.rounds.map((round) => [round.moves, round.reevals])).toEqual([[[], []]]);
    expect(view).toMatchObject({ snapshots: [], syncs: [], snapshotPending: null });
    expect(arRunSummary(run).openSnapshot).toBeNull();
    expect(ArRunViewSchema.parse(view).rounds).toHaveLength(1);
  });
});
