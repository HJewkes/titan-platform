import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { ideaId, OutcomeSchema, type Outcome } from "./schemas.js";
import {
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
import { AUTORESEARCH_WORKFLOW } from "./workflow.js";

/** σ is 0.2 and the default band 1.5 pp, so a 3 pp gain clears the band and a 0.8 pp gain sits inside it whatever the noise. */
const CC = "cc_total_delta_pct";
const POLICY: Policy = {
  ...FIXTURE_POLICY,
  mechanisms: {
    better: { metrics: { [CC]: -3 } },
    "in-band-loses": { metrics: { [CC]: -0.8 }, by_key: { c2: { metrics: { [CC]: 1 } } } },
    flat: { micro: false },
    "hidden-once": { metrics: { [CC]: -3 }, by_key: { r3: { violations: { hidden_regressions: 1 } } } },
    "no-test": { l0: "no-test" },
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

function outcomes(run: WorkflowRun | undefined): Map<string, Outcome> {
  const stops = Object.entries(run?.stepResults ?? {}).filter(([key]) => key.startsWith("ar-stop:"));
  return new Map(stops.map(([, result]) => OutcomeSchema.parse(JSON.parse(result.output!))).map((outcome) => [outcome.ideaId, outcome]));
}

const evalKeys = (ports: FakeArPorts, mechanism: string) => ports.calls.evals.filter((call) => call.ideaId === id(mechanism)).map((call) => call.key);

async function loop(mechanisms: string[], options: Partial<FakeOptions> = {}, config: object = CONFIG, policy: Policy = POLICY) {
  const { repo, ports } = await world(mechanisms, options, policy);
  const host = openHost(ports);
  const run = await host.runtime.wait(start(host, repo, config));
  return { repo, ports, run, outcomes: outcomes(run) };
}

async function until(done: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`${what} not reached within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function latch() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
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
      if (killed || key !== "r2") return;
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

  it("asks the planner once more, naming the quota, when its ops carry no bold idea", async () => {
    const planner = ({ violations }: { violations: string[] }) => ({ add: [proposal("better", { bold: violations.length > 0 })] });
    const { ports, run } = await loop([], { planner });

    expect(run.status).toBe("completed");
    expect(ports.calls.plans.map((call) => call.violations)).toEqual([[], ["no bold idea and no [EXEMPT] reason"]]);
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
  },
};

describe("autoresearch on a second target with its own metric names", () => {
  it("keeps the idea that raises the max-direction metric and rejects by that target's guard and violation, with no micro rung", async () => {
    const { repo, ports, run, outcomes } = await loop(["faster", "faster-slow-tail", "crashy", "slower"], { target: THROUGHPUT_TARGET }, { ...CONFIG, lanes: 2 }, THROUGHPUT);

    expect(run.status).toBe("completed");
    expect(outcomes.get(id("faster"))).toMatchObject({ verdict: "kept", reason: "beyond-band", rungReached: "L3", delta: 10 });
    expect(outcomes.get(id("faster-slow-tail"))).toMatchObject({ verdict: "rejected", reason: "guard:p99_ms" });
    expect(outcomes.get(id("crashy"))).toMatchObject({ verdict: "rejected", reason: "violation:crashes", rungReached: "L2" });
    expect(outcomes.get(id("slower"))).toMatchObject({ verdict: "rejected", reason: "clearly-worse", rungReached: "L2" });
    expect(ports.calls.micro).toEqual([]);
    expect(await git(repo.bare, "rev-parse", ports.calls.ratchet[0]!.ratchetRef)).toBe(outcomes.get(id("faster"))!.head);
  });
});
