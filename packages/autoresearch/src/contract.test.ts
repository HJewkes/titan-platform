import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ideaId, TargetSchema, type Idea, type Proposal, type Target } from "./schemas.js";
import {
  FIXTURE_POLICY,
  FIXTURE_TARGET,
  fakeArPorts,
  fixtureRepo,
  proposal,
  removeFixture,
  type FakeArPorts,
  type FakeOptions,
  type FixtureRepo,
  type Policy,
} from "./test-support/fake-ports.js";
import { openTestHost, type TestHost } from "./test-support/host.js";
import { latch, runLabel, stopOutcomes, until } from "./test-support/runs.js";
import { AUTORESEARCH_WORKFLOW, forkPlan } from "./workflow.js";

const CC = "cc_total_delta_pct";
const POLICY: Policy = {
  ...FIXTURE_POLICY,
  mechanisms: {
    better: { metrics: { [CC]: -3 } },
    "in-band-loses": { metrics: { [CC]: -0.8 }, by_key: { c2: { metrics: { [CC]: 1 } } } },
    flat: { micro: false },
    "flat-2": { micro: false },
    "flat-3": { micro: false },
    "flat-4": { micro: false },
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

function openHost(ports: FakeArPorts, dbPath = ":memory:"): TestHost {
  const host = openTestHost(ports, dbPath);
  hosts.push(host);
  return host;
}

const id = (mechanism: string, overrides: Partial<Proposal> = {}) => ideaId(proposal(mechanism, overrides));
const EXEMPT = { bold: "test script", followup: "test script" };
const CONFIG = { lanes: 3, rounds: 1, minPool: 0 };

/** Round r adds `byRound[r - 1]`, the first proposal bold unless every quota is exempted; a round past the list adds nothing. */
function plannerOf(byRound: Proposal[][]): FakeOptions["planner"] {
  return ({ round }) => {
    const add = byRound[round - 1] ?? [];
    return round === 1 ? { add: add.map((entry, index) => ({ ...entry, bold: index === 0 })) } : { add, exempt: EXEMPT };
  };
}

async function world(byRound: Proposal[][], options: Partial<FakeOptions> = {}, dbPath = ":memory:") {
  const repo = await fixtureRepo(POLICY);
  repos.push(repo);
  const ports = fakeArPorts(repo, POLICY, { planner: plannerOf(byRound), ...options });
  return { repo, ports, host: openHost(ports, dbPath) };
}

async function loop(byRound: Proposal[][], config: object = CONFIG, options: Partial<FakeOptions> = {}) {
  const { repo, ports, host } = await world(byRound, options);
  const run = await host.runtime.wait(host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify(config) }));
  return { repo, ports, run, outcomes: stopOutcomes(run) };
}

const ideas = (...mechanisms: string[]) => mechanisms.map((mechanism) => proposal(mechanism));
const implementsOf = (ports: FakeArPorts, round: number) => ports.calls.implementInputs.filter((input) => input.round === round);

function lockingTarget(): Target {
  const target = structuredClone(FIXTURE_TARGET);
  target.metric.noise.lockAfterPairs = 4;
  target.phases[0]!.baselineRuns = 8;
  return TargetSchema.parse(target);
}

describe("eval keys and the σ pairs they feed", () => {
  it("gives every eval run a distinct key, even two ideas' L2 runs", async () => {
    const { ports } = await loop([ideas("better", "in-band-loses")]);

    const keys = ports.calls.evals.map((call) => call.key);
    const firstRuns = ports.calls.evals.filter((call) => call.ideaId !== null && runLabel(call.key) === "r1");
    expect(firstRuns).toHaveLength(2);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("adds one σ pair per L3 idea when the target echoes the full key as repeat", async () => {
    const { outcomes } = await loop([ideas("in-band-loses", "flat"), ideas("flat-2")], { ...CONFIG, rounds: 2 });

    expect(outcomes.get(id("in-band-loses"))!.against).toMatchObject({ pairs: 3, locked: false });
    expect(outcomes.get(id("flat-2"))!.against).toMatchObject({ pairs: 4, locked: false });
  });

  it("records the engine's lock, not a pair count, when σ locks after four pairs", async () => {
    const { repo, outcomes } = await loop([ideas("flat")], CONFIG, { target: lockingTarget() });

    expect(outcomes.get(id("flat"))!.against).toEqual({ case: "t-alpha", head: repo.pin, bandWidth: expect.any(Number), sigma: expect.any(Number), pairs: 4, locked: true });
  });
});

describe("the fork schedule and lane slots", () => {
  it("resumes the winner's implementer on one follow-up and spawns fresh on the other two picks", async () => {
    const followup = proposal("better-again", { source: "followup", parent: id("better") });
    const { ports, outcomes } = await loop([ideas("better"), [followup, ...ideas("flat", "flat-2")]], { ...CONFIG, rounds: 2 });

    const winnerAgent = outcomes.get(id("better"))!.implementer!.agent;
    const forks = implementsOf(ports, 2).map((input) => ({ id: input.idea.id, fork: input.fork, resumeFrom: input.resumeFrom }));
    expect(forks).toHaveLength(3);
    expect(forks.filter((entry) => entry.fork === "exploit")).toEqual([{ id: ideaId(followup), fork: "exploit", resumeFrom: winnerAgent }]);
    expect(outcomes.get(ideaId(followup))!.implementer).toMatchObject({ agent: winnerAgent, mode: "resume", resumedFrom: winnerAgent });
  });

  it("has every lane explore in a basin-escape round, even after a KEEP", () => {
    const schedule = { afterKeep: { exploit: 1 }, basinEvery: 3 };
    const followup = { id: "i-follow", parent: "i-won" } as Idea;
    const winners = new Map([["i-won", "implementer-a"]]);

    expect(forkPlan([followup], 2, winners, schedule).get("i-follow")).toEqual({ fork: "exploit", resumeFrom: "implementer-a" });
    expect(forkPlan([followup], 3, winners, schedule).get("i-follow")).toEqual({ fork: "explore" });
  });

  it("never hands out a slot past the lane count and reuses a freed slot", async () => {
    const { ports, outcomes } = await loop([ideas("flat", "flat-2", "flat-3", "flat-4", "no-test", "in-band-loses")]);

    const lanes = ports.calls.implementInputs.map((input) => input.lane);
    expect(lanes).toHaveLength(6);
    expect(new Set(lanes)).toEqual(new Set([1, 2, 3]));
    expect([...outcomes.values()].map((outcome) => outcome.lane).every((lane) => lane! >= 1 && lane! <= 3)).toBe(true);
  });

  it("replays the lane slot each ladder first held, though siblings finish in another order on replay", async () => {
    const slow = latch();
    const beforeImplement = async (_idea: Idea, call: number) => {
      if (call === 1) await slow.opened;
      if (call === 3 || call === 4) await new Promise(() => undefined);
    };
    const dir = mkdtempSync(join(tmpdir(), "ar-lanes-"));
    dirs.push(dir);
    const { repo, ports, host } = await world([ideas("flat", "flat-2", "flat-3", "flat-4")], { beforeImplement }, join(dir, "runs.db"));
    const runId = host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify({ ...CONFIG, lanes: 2 }) });
    await until(() => ports.calls.implement.length >= 3, "a third implement");
    slow.open();
    await until(() => ports.calls.implement.length >= 4, "a fourth implement");
    host.close();

    const second = openHost(ports, join(dir, "runs.db"));
    await second.adopt();
    const run = await second.runtime.wait(runId);

    expect(run.status).toBe("completed");
    const [, , third, fourth] = ports.calls.implementInputs;
    expect([third!.lane, fourth!.lane]).toEqual([2, 1]);
    const replayed = ports.calls.implementInputs.slice(4);
    expect(replayed.map((input) => [input.idea.id, input.lane])).toEqual(expect.arrayContaining([[third!.idea.id, 2], [fourth!.idea.id, 1]]));
  });
});

describe("what each step receives and each round records", () => {
  it("gives the micro rung the best's own artifact dir and a directed signal", async () => {
    const { repo, ports } = await loop([ideas("better")]);

    expect(ports.calls.microInputs[0]).toMatchObject({ case: "t-alpha", microSignal: "fewer accepts:down", microArgs: {} });
    expect(ports.calls.microInputs[0]!.baselineDir).toMatch(new RegExp(`^${repo.work}/\\.artifacts/.*-base-b1$`));
  });

  it("names the idea and round on every dead-end and bug row it archives", async () => {
    const { ports } = await loop([ideas("flat", "no-test")]);

    const { registries } = ports.calls.archives[0]!.record;
    expect(registries.deadEnds).toEqual([expect.objectContaining({ ideaId: id("flat"), round: 1 })]);
    expect(registries.bugs).toEqual([expect.objectContaining({ ideaId: id("no-test"), round: 1 })]);
  });

  it("spawns the planner in round 1 and resumes it in round 2", async () => {
    const { ports } = await loop([ideas("flat")], { ...CONFIG, rounds: 2 });

    expect(ports.calls.plans.map((call) => call.mode)).toEqual(["spawn", "resume"]);
  });

  it("hands the ratchet the move's Δ, σ, pin and run digests", async () => {
    const { repo, ports, outcomes } = await loop([ideas("better")]);

    const kept = outcomes.get(id("better"))!;
    expect(ports.calls.ratchet[0]).toMatchObject({ round: 1, ideaId: id("better"), kind: "ff", keepRung: "L3", delta: kept.delta, sigma: kept.against!.sigma, pin: repo.pin });
    expect(ports.calls.ratchet[0]!.runDigests).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  it("records the implementer, lane, fork, L0 rows, micro counts and spend on the ar-stop outcome", async () => {
    const { outcomes } = await loop([ideas("better")]);

    expect(outcomes.get(id("better"))).toMatchObject({
      implementer: { agent: expect.any(String), sessionId: expect.any(String), mode: "spawn", account: "fixture" },
      lane: 1,
      fork: "explore",
      l0: { ok: true, checks: expect.arrayContaining([{ name: "frozen-touch", ok: true }]) },
      micro: { rung: "L1-replay", predicted_direction_met: true },
      usage: { implementUsd: 0, evalUsd: 0, microUsd: 0 },
    });
  });
});
