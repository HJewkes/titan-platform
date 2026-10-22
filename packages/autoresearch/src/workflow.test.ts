import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { RoundSummarySchema } from "./ports.js";
import { IdeaSchema, ideaId, OutcomeSchema, type Outcome, type Proposal } from "./schemas.js";
import {
  FIXTURE_BOUNDS,
  FIXTURE_POLICY,
  THROUGHPUT_POLICY,
  THROUGHPUT_TARGET,
  fakeArPorts,
  fixtureRepo,
  git,
  proposal,
  removeFixture,
  scriptedPlanner,
  type FakeArPorts,
  type FakeOptions,
  type FixtureRepo,
  type Policy,
} from "./test-support/fake-ports.js";
import { openTestHost, type TestHost } from "./test-support/host.js";
import { latch, runLabel, stopOutcomes, until } from "./test-support/runs.js";
import { AUTORESEARCH_WORKFLOW, finalOutcomes, pickWinner } from "./workflow.js";

/** σ is 0.2 and the default band 1.5 pp, so a 3 pp gain clears the band and a 0.8 pp gain sits inside it whatever the noise. */
const CC = "cc_total_delta_pct";
const POLICY: Policy = {
  ...FIXTURE_POLICY,
  mechanisms: {
    better: { metrics: { [CC]: -3 } },
    "better-2": { metrics: { [CC]: -3 } },
    "in-band-loses": { metrics: { [CC]: -0.8 }, by_key: { c2: { metrics: { [CC]: 1 } } } },
    flat: { micro: false },
    "hidden-once": { metrics: { [CC]: -3 }, by_key: { r3: { violations: { hidden_regressions: 1 } } } },
    "no-test": { files: { "src/gate/gates.py": "# no-test\n" } },
  },
};

const hosts: TestHost[] = [];
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  repos.splice(0).forEach(removeFixture);
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const id = (mechanism: string) => ideaId(proposal(mechanism));

async function world(mechanisms: string[], options: Partial<FakeOptions> = {}, policy: Policy = POLICY) {
  const repo = await fixtureRepo(policy);
  repos.push(repo);
  return { repo, ports: fakeArPorts(repo, policy, { planner: scriptedPlanner(mechanisms), ...options }) };
}

function openHost(ports: FakeArPorts, dbPath = ":memory:"): TestHost {
  const host = openTestHost(ports, dbPath);
  hosts.push(host);
  return host;
}

const CONFIG = { lanes: 3, rounds: 1, minPool: 0 };
const start = (host: TestHost, repo: FixtureRepo, config: object = CONFIG) => host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify(config) });

const outcomes = stopOutcomes;
const evalKeys = (ports: FakeArPorts, mechanism: string) => ports.calls.evals.filter((call) => call.ideaId === id(mechanism)).map((call) => runLabel(call.key));

async function loop(mechanisms: string[], options: Partial<FakeOptions> = {}, config: object = CONFIG, policy: Policy = POLICY) {
  const { repo, ports } = await world(mechanisms, options, policy);
  const host = openHost(ports);
  const run = await host.runtime.wait(start(host, repo, config));
  return { repo, ports, run, outcomes: outcomes(run) };
}

describe("autoresearch on a fixture target at $0", () => {
  it("keeps a better idea and fast-forwards the ratchet on the local bare remote", async () => {
    const { repo, ports, run, outcomes } = await loop(["better"]);

    expect(run.status).toBe("completed");
    const kept = outcomes.get(id("better"))!;
    expect(kept).toMatchObject({ verdict: "kept", reason: "beyond-band", rungReached: "L3" });
    const ratchetRef = ports.calls.ratchet[0]!.ratchetRef;
    expect(await git(repo.bare, "rev-parse", ratchetRef)).toBe(kept.head);
    expect(await git(repo.bare, "rev-parse", `${ratchetRef}~1`)).toBe(repo.pin);
  });

  it("gives an idea in the ambiguous band exactly two confirm runs and rejects it when one loses", async () => {
    const { ports, outcomes } = await loop(["in-band-loses"]);

    expect(evalKeys(ports, "in-band-loses")).toEqual(["r1", "r2", "r3", "c1", "c2"]);
    expect(outcomes.get(id("in-band-loses"))).toMatchObject({ verdict: "rejected", reason: "confirm-lost" });
    expect(ports.calls.ratchet).toEqual([]);
  });

  it("stops an idea with no micro signal at L1 without a case eval", async () => {
    const { ports, outcomes } = await loop(["flat"]);

    expect(outcomes.get(id("flat"))).toMatchObject({ verdict: "stopped", rungReached: "L1", reason: "no-micro-signal" });
    expect(evalKeys(ports, "flat")).toEqual([]);
  });

  it("discards an idea with one hidden regression in its three runs", async () => {
    const { outcomes, ports } = await loop(["hidden-once"]);

    expect(outcomes.get(id("hidden-once"))).toMatchObject({ verdict: "rejected", reason: "violation:hidden_regressions", rungReached: "L3" });
    expect(ports.calls.ratchet).toEqual([]);
  });

  it("resumes after a kill past L2 without a second implement or L2 run", async () => {
    const held = latch();
    let killed = false;
    const beforeEval = async (ideaId: string | null, key: string) => {
      if (killed || runLabel(key) !== "r2") return;
      killed = true;
      held.open();
      await new Promise(() => undefined);
    };
    const { repo, ports } = await world(["better"], { beforeEval });
    const dir = mkdtempSync(join(tmpdir(), "ar-resume-"));
    dirs.push(dir);
    const first = openHost(ports, join(dir, "runs.db"));
    const runId = start(first, repo, { ...CONFIG, lanes: 1 });
    await held.opened;
    first.close();

    const second = openHost(ports, join(dir, "runs.db"));
    await second.adopt();
    const run = await second.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(ports.calls.implement).toEqual([id("better")]);
    expect(evalKeys(ports, "better")).toEqual(["r1", "r2", "r2", "r3"]);
    expect(outcomes(run).get(id("better"))).toMatchObject({ verdict: "kept" });
  });

  it("frees an early stop's lane for pick 4 of 6 while picks 2 and 3 still run", async () => {
    const hold = latch();
    const beforeImplement = async (_idea: unknown, call: number) => (call === 2 || call === 3 ? hold.opened : undefined);
    const flats = ["f1", "f2", "f3", "f4", "f5", "f6"];
    const policy: Policy = { ...POLICY, mechanisms: Object.fromEntries(flats.map((name) => [name, { micro: false }])) };
    const { repo, ports } = await world(flats, { beforeImplement }, policy);
    const host = openHost(ports);
    const runId = start(host, repo);

    await until(() => ports.calls.implement.length >= 4, "a fourth implement", 5_000).finally(hold.open);
    const run = await host.runtime.wait(runId);

    expect(outcomes(run).size).toBe(6);
  });

  it("records a failed step as a stop and still runs every sibling pick", async () => {
    const beforeImplement = async (_idea: unknown, call: number) => {
      if (call === 1) throw new Error("implementer crashed");
    };
    const mechanisms = ["better", "flat", "no-test", "in-band-loses", "hidden-once", "f6"];
    const { run, ports, outcomes } = await loop(mechanisms, { beforeImplement });

    expect(run.status).toBe("completed");
    expect(ports.calls.implement).toHaveLength(6);
    expect(outcomes.size).toBe(6);
    expect([...outcomes.values()].filter((outcome) => outcome.reason === "error:ar-implement:1/" + ports.calls.implement[0])).toHaveLength(1);
  });

  it("records the diff size L0 measured and rejects a frozen-file edit at L0", async () => {
    const policy: Policy = { ...POLICY, mechanisms: { ...POLICY.mechanisms, "edit-measure": { files: { "src/gate/measure.py": "# fixed\n", "tests/test_gate.py": "# fixed\n" } } } };
    const { outcomes } = await loop(["better", "edit-measure"], {}, CONFIG, policy);

    expect(outcomes.get(id("better"))!.diff).toEqual({ files: 2, lines: 2, srcFiles: 1, srcLines: 1, testLines: 1 });
    expect(outcomes.get(id("edit-measure"))).toMatchObject({ verdict: "rejected", reason: "rejected:post:frozen-touch", rungReached: "L0" });
  });

  it("stops before the baseline when a class names a frozen file", async () => {
    const bounds = structuredClone(FIXTURE_BOUNDS);
    bounds.classes["accept-gate"]!.paths.push("src/gate/measure.py");
    const { ports, run } = await loop(["better"], { bounds });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("[bounds-frozen] src/gate/measure.py");
    expect(ports.calls.evals).toEqual([]);
  });

  it("asks the planner once more, naming the quota, when its ops carry no bold idea", async () => {
    const planner = ({ violations }: { violations: string[] }) => ({ add: [proposal("better", { bold: violations.length > 0 })] });
    const { ports, run } = await loop([], { planner });

    expect(run.status).toBe("completed");
    expect(ports.calls.plans.map((call) => call.violations)).toEqual([[], ["no bold idea and no [EXEMPT] reason"]]);
  });
});

describe("inputs a restarted host can act on", () => {
  it("names the run and its recorded pin on every evaluator step, the baseline included", async () => {
    const { repo, ports, run } = await loop(["better"]);

    const steps = new Set(ports.calls.runPins.map((call) => call.step));
    expect(steps).toEqual(new Set(["eval", "l0", "l1", "ratchet"]));
    const expected = { runId: run.id, pin: repo.pin, frozenHash: "f".repeat(64) };
    expect(ports.calls.runPins.filter((call) => JSON.stringify(call.runPin) !== JSON.stringify(expected))).toEqual([]);
  });

  it("gives the implementer the run id, so a host need not read it off the tree name", async () => {
    const { ports, run } = await loop(["better"]);

    expect(ports.calls.implementInputs.map((input) => input.runId)).toEqual([run.id]);
  });

  it("records the planner that wrote the round's ops on the round", async () => {
    const { ports, run } = await loop(["better"]);

    expect(ports.calls.archives[0]!.record.planner).toEqual({
      agent: `planner-${run.id}`, sessionId: `session-planner-${run.id}`, mode: "spawn", usage: { usd: 0.25, cacheReadTokens: 40, retries: 0 },
    });
  });
});

const RPS = "throughput_rps";
const THROUGHPUT: Policy = {
  ...THROUGHPUT_POLICY,
  mechanisms: {
    faster: { metrics: { [RPS]: 10 } },
    "faster-slow-tail": { metrics: { [RPS]: 10, p99_ms: 20 } },
    crashy: { metrics: { [RPS]: 10 }, violations: { crashes: 1 } },
    slower: { metrics: { [RPS]: -10 } },
    "faster-fewer-served": { metrics: { [RPS]: 10, requests_served: -10 } },
  },
};

describe("autoresearch on a second target with its own metric names", () => {
  it("keeps the idea that raises the max-direction metric and rejects by that target's guard and violation, with no micro rung", async () => {
    const { repo, ports, run, outcomes } = await loop(["faster", "faster-slow-tail", "crashy", "slower", "faster-fewer-served"], { target: THROUGHPUT_TARGET }, CONFIG, THROUGHPUT);

    expect(run.status).toBe("completed");
    expect(outcomes.get(id("faster"))).toMatchObject({ verdict: "kept", reason: "beyond-band", rungReached: "L3", delta: 10 });
    expect(outcomes.get(id("faster-slow-tail"))).toMatchObject({ verdict: "rejected", reason: "guard:p99_ms" });
    expect(outcomes.get(id("faster-fewer-served"))).toMatchObject({ verdict: "rejected", reason: "guard:requests_served" });
    expect(outcomes.get(id("crashy"))).toMatchObject({ verdict: "rejected", reason: "violation:crashes", rungReached: "L2" });
    expect(outcomes.get(id("slower"))).toMatchObject({ verdict: "rejected", reason: "clearly-worse", rungReached: "L2" });
    expect(ports.calls.micro).toEqual([]);
    expect(await git(repo.bare, "rev-parse", ports.calls.ratchet[0]!.ratchetRef)).toBe(outcomes.get(id("faster"))!.head);
  });
});

describe("picking the winner that moves the ratchet", () => {
  const winner = (ideaId: string, delta: number, srcLines: number): Outcome =>
    OutcomeSchema.parse({ ideaId, lineage: ideaId, cell: "c", verdict: "kept", reason: "beyond-band", rungReached: "L3", delta, diff: { files: 1, lines: srcLines, srcFiles: 1, srcLines } });

  it("takes the smaller diff among winners within one σ of the strongest", () => {
    expect(pickWinner([winner("big", 3, 40), winner("small", 2.6, 5)], 0.5).map((outcome) => outcome.ideaId)).toEqual(["small", "big"]);
  });

  it("takes the larger Δ when the gap is more than one σ", () => {
    expect(pickWinner([winner("small", 2, 5), winner("big", 3, 40)], 0.5).map((outcome) => outcome.ideaId)).toEqual(["big", "small"]);
  });
});

const seedOf = <T>(run: WorkflowRun, key: string, schema: z.ZodType<T>): T => schema.parse(JSON.parse(run.stepResults[key]!.output!));
const dispatchedOf = (run: WorkflowRun, stepId: string) => z.object({ result: z.unknown() }).parse(run.stepResults[`${stepId}:0`]!.data).result;
const summaryOf = (run: WorkflowRun, round: number) => seedOf(run, `ar-summary:${round}`, RoundSummarySchema);
const queueOf = (run: WorkflowRun, round: number) => seedOf(run, `ar-queue:${round}`, z.object({ queue: z.array(IdeaSchema) })).queue;
const endOf = (run: WorkflowRun) => seedOf(run, "ar-end", z.object({ stopReason: z.string() })).stopReason;

describe("what a round records for readers", () => {
  it("records the kept winner, the superseded one and the ratchet move on the round summary", async () => {
    const { repo, run, ports } = await loop(["better", "better-2"]);

    const summary = summaryOf(run, 1);
    const [first, second] = [ports.calls.ratchet[0]!.ideaId, [id("better"), id("better-2")].find((ideaId) => ideaId !== ports.calls.ratchet[0]!.ideaId)];
    expect(summary).toMatchObject({ round: 1, keptIds: [first], superseded: [second], ratchet: { from: repo.pin, to: ports.calls.ratchet[0]!.to } });
    expect(summary.best.head).toBe(ports.calls.ratchet[0]!.to);
  });

  it("names the first planner answer's quota misses when the retry met them", async () => {
    const planner = ({ violations }: { violations: string[] }) => ({ add: [proposal("better", { bold: violations.length > 0 })] });
    const { run } = await loop([], { planner });

    expect(summaryOf(run, 1)).toMatchObject({ plannerRetried: true, quotaViolations: ["no bold idea and no [EXEMPT] reason"] });
  });

  it("settles the same outcomes the archive received: the superseded winner stopped, every one stamped with σ", async () => {
    const { run, ports } = await loop(["better", "better-2", "flat"]);
    const summary = summaryOf(run, 1);

    const settled = finalOutcomes([...stopOutcomes(run).values()], { sigma: summary.against.sigma, superseded: summary.superseded });

    const byId = (outcomes: readonly Outcome[]) => [...outcomes].sort((a, b) => a.ideaId.localeCompare(b.ideaId));
    expect(byId(settled)).toEqual(byId(ports.calls.archives[0]!.record.outcomes));
    expect(settled.find((outcome) => outcome.ideaId === summary.superseded[0])).toMatchObject({ verdict: "stopped", reason: "superseded" });
    expect(settled.every((outcome) => outcome.sigma === summary.against.sigma)).toBe(true);
  });

  it("records why the loop ended: rounds without gain, or the round limit", async () => {
    const { run } = await loop(["flat"], {}, { ...CONFIG, rounds: 5 });
    const { run: short } = await loop(["flat"]);

    expect(endOf(run)).toBe("rounds-without-gain");
    expect(run.stepResults["ar-plan:4:0"]).toBeUndefined();
    expect(endOf(short)).toBe("rounds-exhausted");
  });
});

describe("owner ideas", () => {
  const owned = (mechanism: string) => proposal(mechanism, { source: "planner", bold: true });

  it("queues an owner idea written between rounds with source owner, and reads the inbox from where it left off", async () => {
    const inbox = [owned("flat")];
    const planner: FakeOptions["planner"] = ({ round }) => {
      if (round === 1) inbox.push(owned("flat-late"));
      if (round === 1) return { add: [proposal("better", { bold: true })] };
      return { add: [proposal("flat-2")], drop: [{ id: id("flat-late") }], exempt: { bold: "test", followup: "test" } };
    };
    const { run, ports } = await loop([], { planner, inbox }, { ...CONFIG, rounds: 2 });

    expect(queueOf(run, 2).find((idea) => idea.id === id("flat-late"))).toMatchObject({ source: "owner" });
    expect(queueOf(run, 1).find((idea) => idea.id === id("flat"))).toMatchObject({ source: "owner" });
    expect(ports.calls.inbox).toEqual([{ round: 1, after: 0 }, { round: 2, after: 1 }]);
  });

  it("replays the recorded inbox answer after a kill, whatever the inbox holds by then", async () => {
    const inbox: Proposal[] = [];
    const held = latch();
    let killed = false;
    const beforePlan = async (round: number) => {
      if (round !== 2 || killed) return;
      killed = true;
      inbox.push(owned("flat-after-kill"));
      held.open();
      await new Promise(() => undefined);
    };
    const planner: FakeOptions["planner"] = ({ round }) => (round === 1 ? (inbox.push(owned("flat")), { add: [proposal("better", { bold: true })] }) : { exempt: { bold: "test", followup: "test" } });
    const { repo, ports } = await world([], { planner, inbox, beforePlan });
    const dir = mkdtempSync(join(tmpdir(), "ar-inbox-"));
    dirs.push(dir);
    const first = openHost(ports, join(dir, "runs.db"));
    const runId = start(first, repo, { ...CONFIG, rounds: 2 });
    await held.opened;
    first.close();

    const second = openHost(ports, join(dir, "runs.db"));
    await second.adopt();
    const run = await second.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(dispatchedOf(run, "ar-inbox:2")).toMatchObject({ cursor: 1 });
    expect(queueOf(run, 2).map((idea) => idea.id)).toEqual([id("flat")]);
  });
});

describe("the phase registry row", () => {
  it("counts each evaluated idea once by rung and names every round archive", async () => {
    const { run, ports } = await loop(["better", "better-2", "flat"]);

    expect(ports.calls.registry).toHaveLength(1);
    const { row } = ports.calls.registry[0]!;
    const evaluated = [...stopOutcomes(run).values()].length - summaryOf(run, 1).superseded.length;
    expect(Object.values(row.ideasByRung).reduce((total, count) => total + count, 0)).toBe(evaluated);
    expect(evaluated).toBe(2);
    expect(row.archives).toEqual(ports.calls.archives.map(({ round }) => expect.stringContaining(`round-${round}.json`)));
    expect(row).toMatchObject({ phase: "p1", trainCases: ["t-alpha"], stopReason: "rounds-exhausted", spend: { agentUsd: 0.25, cacheReadTokens: 40 } });
    expect(dispatchedOf(run, "ar-registry:p1")).toEqual({ path: expect.stringContaining("registry.jsonl") });
  });
});
