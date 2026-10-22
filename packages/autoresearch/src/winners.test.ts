import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { median } from "./keep.js";
import { ReevalSchema, RoundSummarySchema } from "./ports.js";
import { arRunSummary, arRunView } from "./read-model.js";
import { IdeaSchema, ideaId, type Proposal } from "./schemas.js";
import { FIXTURE_POLICY, fakeArPorts, fixtureRepo, git, proposal, removeFixture, type FakeArPorts, type FakeOptions, type FixtureRepo, type Policy } from "./test-support/fake-ports.js";
import { openTestHost, type TestHost } from "./test-support/host.js";
import { latch, stopOutcomes } from "./test-support/runs.js";
import { AUTORESEARCH_WORKFLOW } from "./workflow.js";

/** `a` gains 4 pp and `b` 3 pp, so `a` always goes first; `b` edits the planner files, so the two merge cleanly. */
const CC = "cc_total_delta_pct";
const PROPOSALS: Record<string, Partial<Proposal>> = {
  b: { class: "planner-ranking", targets: ["src/planner/rank.py"] },
  "b-cancelled": { class: "planner-ranking", targets: ["src/planner/rank.py"] },
};
const POLICY: Policy = {
  ...FIXTURE_POLICY,
  mechanisms: { a: { metrics: { [CC]: -4 } }, b: { metrics: { [CC]: -3 } }, "b-cancelled": { metrics: { [CC]: -3 } }, "a-same-file": { metrics: { [CC]: -3 } } },
  /** With `a` in the tree, `b-cancelled` loses its gain and a little more. */
  interactions: { "a+b-cancelled": { metrics: { [CC]: 3.5 } } },
  usd: { eval: 0.1 },
};

const proposed = (mechanism: string) => proposal(mechanism, { bold: true, ...PROPOSALS[mechanism] });
const id = (mechanism: string) => ideaId(proposed(mechanism));
const planner = (mechanisms: readonly string[]) => ({ round }: { round: number }) =>
  round === 1 ? { add: mechanisms.map(proposed) } : { exempt: { bold: "script ends after round one", followup: "script ends after round one" } };

const hosts: TestHost[] = [];
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  repos.splice(0).forEach(removeFixture);
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function world(mechanisms: string[], options: Partial<FakeOptions> = {}) {
  const repo = await fixtureRepo(POLICY);
  repos.push(repo);
  return { repo, ports: fakeArPorts(repo, POLICY, { planner: planner(mechanisms), ...options }) };
}

function openHost(ports: FakeArPorts, dbPath = ":memory:"): TestHost {
  const host = openTestHost(ports, dbPath);
  hosts.push(host);
  return host;
}

const CONFIG = { lanes: 2, rounds: 1, minPool: 0 };
const start = (host: TestHost, repo: FixtureRepo, config: object) => host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify(config) });

async function loop(mechanisms: string[], { config = CONFIG, drop = false }: { config?: object; drop?: boolean } = {}) {
  const { repo, ports } = await world(mechanisms);
  if (drop) delete ports.integrate;
  const host = openHost(ports);
  const run = await host.runtime.wait(start(host, repo, config));
  return { repo, ports, run };
}

const seedOf = <T>(run: WorkflowRun, stepId: string, schema: z.ZodType<T>) => schema.parse(JSON.parse(run.stepResults[stepId]!.output!));
const reevalOf = (run: WorkflowRun, mechanism: string) => seedOf(run, `ar-reeval:1/${id(mechanism)}`, ReevalSchema);
const summaryOf = (run: WorkflowRun) => seedOf(run, "ar-summary:1", RoundSummarySchema);
const ratchetHead = (repo: FixtureRepo, ports: FakeArPorts) => git(repo.bare, "rev-parse", ports.calls.ratchet[0]!.ratchetRef);
const archived = (ports: FakeArPorts, mechanism: string) => ports.calls.archives[0]!.record.outcomes.find((outcome) => outcome.ideaId === id(mechanism));

describe("a later winner re-evaluated on top of the round's new head", () => {
  it("rejects a winner whose gain the first winner cancels, and leaves the ratchet on the first", async () => {
    const { repo, ports, run } = await loop(["a", "b-cancelled"]);
    const first = stopOutcomes(run).get(id("a"))!;

    expect(stopOutcomes(run).get(id("b-cancelled"))).toMatchObject({ verdict: "kept" });
    expect(reevalOf(run, "b-cancelled")).toMatchObject({ decision: "rejected", vs: first.head, merge: expect.any(String) });
    expect(ports.calls.ratchet.map((request) => request.kind)).toEqual(["ff"]);
    expect(await ratchetHead(repo, ports)).toBe(first.head);
    expect(archived(ports, "b-cancelled")).toMatchObject({ verdict: "rejected", reason: expect.stringMatching(/^reeval:/), reeval: { vs: first.head, decision: "rejected" } });
  });

  it("requeues a winner whose merge conflicts on its own lineage, and the next round picks it", async () => {
    const { run } = await loop(["a", "a-same-file"], { config: { ...CONFIG, rounds: 2 } });
    const original = seedOf(run, "ar-queue:1", z.object({ queue: z.array(IdeaSchema) })).queue.find((idea) => idea.id === id("a-same-file"))!;

    expect(reevalOf(run, "a-same-file")).toMatchObject({ decision: "requeued", reason: "conflict", merge: null, conflict: expect.arrayContaining(["src/gate/gates.py"]) });
    expect(summaryOf(run).superseded).toEqual([id("a-same-file")]);
    const requeued = seedOf(run, "ar-queue:2", z.object({ queue: z.array(IdeaSchema) })).queue.find((idea) => idea.id === id("a-same-file"));
    expect(requeued).toMatchObject({ source: "requeue", lineage: original.lineage, round: 2 });
  });

  it("keeps a winner that still clears the new B: two moves, a merge commit on the ratchet and B's runs from the re-evaluation", async () => {
    const { repo, ports, run } = await loop(["a", "b"]);
    const [first, later] = [stopOutcomes(run).get(id("a"))!, stopOutcomes(run).get(id("b"))!];
    const reeval = reevalOf(run, "b");

    expect(reeval).toMatchObject({ decision: "kept", vs: first.head });
    expect(summaryOf(run).moves).toEqual([
      { from: repo.pin, to: first.head, kind: "ff", ideaId: id("a") },
      { from: first.head, to: reeval.merge, kind: "merge", ideaId: id("b") },
    ]);
    expect(summaryOf(run).ratchet).toEqual({ from: repo.pin, to: reeval.merge });
    expect((await git(repo.bare, "rev-list", "--parents", "-n", "1", await ratchetHead(repo, ports))).split(" ").slice(1)).toEqual([first.head, later.head]);
    expect(summaryOf(run).best).toEqual({ head: reeval.merge, primary: median(reeval.runs.map((result) => result.metrics[CC]!)) });
    expect(summaryOf(run).keptIds).toEqual([id("a"), id("b")]);
  });

  it("runs the re-evaluation under its own scope, so the solo ladder's runs and Δ stay its own", async () => {
    const { ports, run } = await loop(["a", "b"]);
    const solo = stopOutcomes(run).get(id("b"))!;
    const reeval = reevalOf(run, "b");

    const evalSteps = Object.values(run.stepResults).map((result) => result.stepId).filter((stepId) => stepId.startsWith("ar-eval:1/"));
    expect(evalSteps.filter((stepId) => stepId.startsWith(`ar-eval:1/re/${id("b")}:`)).sort()).toEqual(["r1", "r2", "r3"].map((label) => `ar-eval:1/re/${id("b")}:${label}`));
    const level = (runs: typeof solo.runs) => median(runs.map((result) => result.metrics[CC]!));
    expect(level(reeval.runs)).toBeLessThan(level(solo.runs) - 2);
    expect(archived(ports, "b")).toMatchObject({ delta: solo.delta, runs: solo.runs });
  });

  it("does not merge again after a kill once the integrate step is recorded, and moves the ratchet onto the same merge", async () => {
    const held = latch();
    let killed = false;
    const beforeEval = async (_ideaId: string | null, key: string) => {
      if (killed || !key.includes("-re-")) return;
      killed = true;
      held.open();
      await new Promise(() => undefined);
    };
    const { repo, ports } = await world(["a", "b"], { beforeEval });
    const dir = mkdtempSync(join(tmpdir(), "ar-winners-"));
    dirs.push(dir);
    const first = openHost(ports, join(dir, "runs.db"));
    const runId = start(first, repo, CONFIG);
    await held.opened;
    first.close();

    const second = openHost(ports, join(dir, "runs.db"));
    await second.adopt();
    const run = await second.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(ports.calls.integrate).toHaveLength(1);
    expect(await ratchetHead(repo, ports)).toBe(reevalOf(run, "b").merge);
  });

  it("counts the re-evaluation's eval dollars in the run's model spend", async () => {
    const { ports } = await loop(["a", "b"]);

    expect(ports.calls.evals.filter((call) => call.key.includes("-re-"))).toHaveLength(3);
    expect(ports.calls.registry[0]!.row.spend.modelUsd).toBeCloseTo(ports.calls.evals.length * 0.1, 9);
  });

  it("requeues every later winner on a host with no integrate port, never keeping one on its solo run", async () => {
    const { repo, ports, run } = await loop(["a", "b"], { drop: true });

    expect(reevalOf(run, "b")).toMatchObject({ decision: "requeued", reason: "no-integrate", merge: null, runs: [] });
    expect(summaryOf(run)).toMatchObject({ keptIds: [id("a")], superseded: [id("b")] });
    expect(ports.calls.ratchet).toHaveLength(1);
    expect(await ratchetHead(repo, ports)).toBe(stopOutcomes(run).get(id("a"))!.head);
  });
});

describe("a run recorded before concurrent winners", () => {
  const recordedRun = (): WorkflowRun => JSON.parse(readFileSync(new URL("./test-support/fixtures/run-38ef0296.json", import.meta.url), "utf8"));

  it("still parses: its round has no moves or re-evaluations, and its superseded winner reads as before", () => {
    const run = recordedRun();
    const summary = summaryOf(run);
    const view = arRunView(run)!;

    expect(summary).toMatchObject({ moves: [], reevals: [] });
    const ladder = view.rounds[0]!.ladders.find((entry) => entry.idea.id === summary.superseded[0])!;
    expect(ladder.outcome).toMatchObject({ verdict: "stopped", reason: "superseded" });
    expect(ladder.outcome!.reeval).toBeUndefined();
    expect(view.rounds[0]!.ratchet).toEqual(summary.ratchet);
    expect(arRunSummary(run).best).toEqual(summary.best);
  });
});
