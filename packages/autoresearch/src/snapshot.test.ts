import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { RoundSummarySchema, SnapshotResultSchema, type SyncRequest } from "./ports.js";
import { ideaId, type Proposal } from "./schemas.js";
import { cadence, CadenceSchema, startSnapshots, SnapshotSettingsSchema, type SnapshotState } from "./snapshot.js";
import { FIXTURE_POLICY, fakeArPorts, fixtureRepo, git, proposal, removeFixture, writeFiles, type FakeArPorts, type FakeOptions, type FixtureRepo, type Policy } from "./test-support/fake-ports.js";
import { openTestHost, type TestHost } from "./test-support/host.js";
import { latch, until } from "./test-support/runs.js";
import { AUTORESEARCH_WORKFLOW } from "./workflow.js";

const CC = "cc_total_delta_pct";
const POLICY: Policy = { ...FIXTURE_POLICY, mechanisms: { a: { metrics: { [CC]: -4 } }, b: { metrics: { [CC]: -3 } }, c: { metrics: { [CC]: -3 } } } };
/** `b` edits the planner files, so it merges cleanly beside `a` in one round. */
const PROPOSALS: Record<string, Partial<Proposal>> = { b: { class: "planner-ranking", targets: ["src/planner/rank.py"] } };
const proposed = (mechanism: string) => proposal(mechanism, { bold: true, ...PROPOSALS[mechanism] });
const id = (mechanism: string) => ideaId(proposed(mechanism));
const EXEMPT = { bold: "script ends", followup: "script ends" };
/** Round r adds `byRound[r - 1]`, every round exempt from the follow-up quota. */
const planner = (byRound: string[][]) => ({ round }: { round: number }) => (byRound[round - 1] ? { add: byRound[round - 1]!.map(proposed), exempt: { followup: "test" } } : { exempt: EXEMPT });

const hosts: TestHost[] = [];
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  repos.splice(0).forEach(removeFixture);
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function world(byRound: string[][], options: Partial<FakeOptions> = {}, policy: Policy = POLICY) {
  const repo = await fixtureRepo(policy);
  repos.push(repo);
  return { repo, ports: fakeArPorts(repo, policy, { planner: planner(byRound), ...options }) };
}

function openHost(ports: FakeArPorts, dbPath = ":memory:"): TestHost {
  const host = openTestHost(ports, dbPath);
  hosts.push(host);
  return host;
}

const start = (host: TestHost, repo: FixtureRepo, config: object) =>
  host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify({ lanes: 2, minPool: 0, ...config }) });

async function loop(byRound: string[][], config: object, options: Partial<FakeOptions> = {}, policy: Policy = POLICY) {
  const { repo, ports } = await world(byRound, options, policy);
  const host = openHost(ports);
  const run = await host.runtime.wait(start(host, repo, config));
  return { repo, ports, run };
}

const seedOf = <T>(run: WorkflowRun, stepId: string, schema: z.ZodType<T>) => schema.parse(JSON.parse(run.stepResults[stepId]!.output!));
const cadenceOf = (run: WorkflowRun, round: number | "end") => seedOf(run, `ar-cadence:${round}`, CadenceSchema);
const summaryOf = (run: WorkflowRun, round: number) => seedOf(run, `ar-summary:${round}`, RoundSummarySchema);
const resultsOf = (run: WorkflowRun, stepId: string) => Object.values(run.stepResults).filter((result) => result.stepId === stepId);
const stepIds = (run: WorkflowRun, prefix: string) => Object.values(run.stepResults).map((result) => result.stepId).filter((stepId) => stepId.startsWith(prefix));

/** Main merged into the ratchet head: one more commit outside `applied/`, pushed to the ratchet as the sync port would. */
async function mainMergedOnto(repo: FixtureRepo, { head, ratchetRef }: SyncRequest, file = "docs/main.md"): Promise<string> {
  await git(repo.work, "checkout", "--quiet", "--detach", head);
  writeFiles(repo.work, { [file]: `${file} from main\n` });
  await git(repo.work, "add", "--all");
  await git(repo.work, "commit", "--quiet", "-m", "merge main into the ratchet");
  const merged = await git(repo.work, "rev-parse", "HEAD");
  await git(repo.work, "push", "--quiet", `--force-with-lease=${ratchetRef}:${head}`, "origin", `${merged}:${ratchetRef}`);
  return merged;
}

const settings = SnapshotSettingsSchema.parse({ keptIdeas: 2, spendUsd: 5 });
const kept = (count: number): SnapshotState => ({ ...startSnapshots("s0"), kept: Array.from({ length: count }, (_, index) => ({ ideaId: `i-${index}` })) });
const OPEN = { k: 1, pr: 101, branch: "b", tag: "t", sha: "s1", carried: { kept: [], from: "s0" } };

describe("the snapshot cadence", () => {
  it("names the phase end over kept ideas and spend, then kept ideas over spend", () => {
    const over = { agentUsd: 3, modelUsd: 3 };

    expect(cadence(kept(2), over, settings, "rounds-exhausted").trigger).toBe("phase-end");
    expect(cadence(kept(2), over, settings).trigger).toBe("kept");
    expect(cadence(kept(1), over, settings).trigger).toBe("spend");
    expect(cadence(kept(1), { agentUsd: 2, modelUsd: 2 }, settings)).toMatchObject({ due: false, trigger: null, spentSince: 4 });
  });

  it("is never due with nothing kept since the last cut, however much was spent", () => {
    expect(cadence(kept(0), { agentUsd: 50, modelUsd: 50 }, settings, "rounds-exhausted")).toMatchObject({ due: false, trigger: null });
  });

  it("holds a due cut while the last snapshot is open", () => {
    expect(cadence({ ...kept(2), open: OPEN }, { agentUsd: 0, modelUsd: 0 }, settings)).toEqual({ due: true, trigger: "kept", blockedBy: "open", keptSince: 2, spentSince: 0 });
  });
});

describe("snapshot cuts in a run", () => {
  it("cuts one snapshot while it is open, records the next due cut as blocked, and keeps running rounds", async () => {
    const { ports, run } = await loop([["a"], ["b"], ["c"]], { rounds: 3, snapshot: { keptIdeas: 1 } });

    expect(run.status).toBe("completed");
    expect(ports.calls.snapshot.map((input) => [input.k, input.round, input.trigger])).toEqual([[1, 1, "kept"]]);
    expect(cadenceOf(run, 2)).toMatchObject({ due: true, trigger: "kept", blockedBy: "open" });
    expect(stepIds(run, "ar-snapshot:")).toEqual(["ar-snapshot:1"]);
    expect(ports.calls.plans.map((plan) => plan.round)).toContain(3);
    expect(ports.calls.sync.map((input) => [input.round, input.pr])).toEqual([[2, 101], [3, 101], ["end", 101]]);
  });

  it("is due on agent dollars alone: two implementers at $0.60 each with free evals", async () => {
    const policy = { ...POLICY, usd: { eval: 0, implement: 0.6 } };
    const { ports, run } = await loop([["a", "b"]], { rounds: 1, snapshot: { spendUsd: 1 } }, {}, policy);

    expect(cadenceOf(run, 1)).toMatchObject({ due: true, trigger: "spend", keptSince: 2 });
    const { agentUsd, modelUsd } = ports.calls.snapshot[0]!.log.spentSince;
    expect([agentUsd, modelUsd]).toEqual([expect.closeTo(1.45), 0]);
  });

  it("is due on model dollars alone when no implementer charges", async () => {
    const policy = { ...POLICY, usd: { eval: 0.2, implement: 0 } };
    const { ports, run } = await loop([["a"]], { rounds: 1, snapshot: { spendUsd: 1 } }, {}, policy);

    expect(cadenceOf(run, 1)).toMatchObject({ due: true, trigger: "spend", keptSince: 1 });
    expect(ports.calls.snapshot[0]!.log.spentSince.agentUsd).toBeLessThan(1);
  });

  it("logs the kept ideas with their Δ and σ and the shas the cut spans", async () => {
    const { repo, ports, run } = await loop([["a"]], { rounds: 1, snapshot: { keptIdeas: 1 } });
    const { log, sha } = ports.calls.snapshot[0]!;

    expect(log).toMatchObject({ phase: "p1", trigger: "kept", round: 1, from: repo.pin, to: summaryOf(run, 1).best.head });
    expect(log.kept).toEqual([{ ideaId: id("a"), delta: expect.any(Number), sigma: expect.any(Number) }]);
    expect(sha).toBe(summaryOf(run, 1).best.head);
  });

  it("records a snapshot port that throws as a failed cut, keeps running, and cuts the next round under the same k", async () => {
    const snapshot = async (input: { k: number }, call: number) => {
      if (call === 1) throw new Error("[snapshot-fixture] the push was refused");
      return { k: input.k, tag: "refs/tags/ar/fixture/r/m1", sha: "s", branch: "refs/heads/autoresearch/fixture-snap/r/m1", pr: 7, logSha: "l" };
    };
    const { ports, run } = await loop([["a"], ["b"]], { rounds: 2, snapshot: { keptIdeas: 1 } }, { snapshot });

    expect(run.status).toBe("completed");
    expect(resultsOf(run, "ar-snapshot:1").map((result) => z.object({ result: SnapshotResultSchema }).parse(result.data).result)).toEqual([
      { failed: "[snapshot-fixture] the push was refused" },
      expect.objectContaining({ k: 1, pr: 7 }),
    ]);
    expect(seedOf(run, "ar-cadence:1.failed", z.object({ k: z.number(), error: z.string() }))).toEqual({ k: 1, error: "[snapshot-fixture] the push was refused" });
    expect(ports.calls.snapshot.map((input) => input.log.kept.length)).toEqual([1, 2]);
  });

  it("goes on without a snapshot when the cut's answer fails its schema, and retries it at the phase end", async () => {
    const snapshot = async () => ({ k: 1, tag: "t", sha: "s", branch: "b", pr: -1, logSha: "l" });
    const { ports, run } = await loop([["a"]], { rounds: 1, snapshot: { keptIdeas: 1 } }, { snapshot });

    expect(run.status).toBe("completed");
    expect(ports.calls.snapshot.map((input) => [input.k, input.round])).toEqual([[1, 1], [1, "end"]]);
    expect(seedOf(run, "ar-cadence:1.failed", z.object({ k: z.number(), error: z.string() }))).toMatchObject({ k: 1 });
    expect(ports.calls.sync).toEqual([]);
  });

  it("ends with the due cut pending behind the open one and never waits for it to merge", async () => {
    const { ports, run } = await loop([["a"], ["b"]], { rounds: 2, snapshot: { keptIdeas: 1 } });

    expect(run.status).toBe("completed");
    expect(cadenceOf(run, "end")).toMatchObject({ due: true, trigger: "phase-end", blockedBy: "open" });
    expect(ports.calls.sync.map((input) => input.round)).toEqual([2, "end"]);
    expect(ports.calls.snapshot).toHaveLength(1);
  });

  it("cuts the phase end once nothing is open", async () => {
    const { ports } = await loop([["a"]], { rounds: 1, snapshot: { keptIdeas: 3 } });

    expect(ports.calls.snapshot.map((input) => [input.round, input.trigger])).toEqual([["end", "phase-end"]]);
  });

  it("replays the recorded cadence after a kill past the cut, with no second snapshot", async () => {
    const held = latch();
    let killed = false;
    const beforePlan = async (round: number) => {
      if (round !== 2 || killed) return;
      killed = true;
      held.open();
      await new Promise(() => undefined);
    };
    const { repo, ports } = await world([["a"], ["b"]], { beforePlan });
    const dir = mkdtempSync(join(tmpdir(), "ar-snapshot-"));
    dirs.push(dir);
    const first = openHost(ports, join(dir, "runs.db"));
    const runId = start(first, repo, { rounds: 2, snapshot: { keptIdeas: 1 } });
    await held.opened;
    first.close();

    const second = openHost(ports, join(dir, "runs.db"));
    await second.adopt();
    const run = await second.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(ports.calls.snapshot).toHaveLength(1);
    expect(cadenceOf(run, 1)).toMatchObject({ due: true, trigger: "kept", blockedBy: null });
  });
});

describe("ar-sync", () => {
  async function synced(treeChanged: boolean) {
    const merges: string[] = [];
    const sync = async (input: SyncRequest) => {
      const to = await mainMergedOnto(repos[0]!, input);
      merges.push(to);
      return { state: "merged" as const, merged: { from: input.head, to, main: to }, treeChanged };
    };
    const { ports, run } = await loop([["a"]], { rounds: 2, snapshot: { keptIdeas: 1 } }, { sync });
    return { ports, run, merged: merges[0]! };
  }

  it("re-measures B with three runs when main changed the tree, and runs the round against the merge", async () => {
    const { run, merged } = await synced(true);

    expect(stepIds(run, "ar-eval:sync-2:")).toEqual(["ar-eval:sync-2:r1", "ar-eval:sync-2:r2", "ar-eval:sync-2:r3"]);
    expect(summaryOf(run, 2).against.head).toBe(merged);
  });

  it("keeps B's runs when only the log changed", async () => {
    const { run, merged } = await synced(false);

    expect(stepIds(run, "ar-eval:sync-")).toEqual([]);
    expect(summaryOf(run, 2).against.head).toBe(merged);
  });

  it("rolls a closed PR's kept ideas into the next cut, from where that cut started", async () => {
    const sync = async () => ({ state: "closed" as const });
    const { repo, ports } = await loop([["a"], ["b"]], { rounds: 2, snapshot: { keptIdeas: 1 } }, { sync });

    const both = [id("a"), id("b")];
    expect(ports.calls.snapshot.map((input) => input.log.kept.map((row) => row.ideaId))).toEqual([[id("a")], both, both]);
    expect(ports.calls.snapshot.map((input) => [input.k, input.round, input.log.from])).toEqual([[1, 1, repo.pin], [2, 2, repo.pin], [3, "end", repo.pin]]);
  });

  it("holds the next round at a gate on a conflict, then runs it from the owner's resolved merge", async () => {
    const sync = async (input: SyncRequest) => {
      if (!input.resolved) return { state: "merged" as const, conflict: ["src/config.json"] };
      return { state: "merged" as const, merged: { from: input.head, to: input.resolved, main: input.resolved }, treeChanged: false };
    };
    const { repo, ports } = await world([["a"]], { sync });
    const host = openHost(ports);
    const runId = start(host, repo, { rounds: 2, snapshot: { keptIdeas: 1 } });
    await until(() => host.runtime.status(runId)?.status !== "running", "the sync gate");

    expect(host.runtime.status(runId)).toMatchObject({ status: "paused", error: null });
    expect(ports.calls.plans.map((plan) => plan.round)).toEqual([1]);
    const resolved = await mainMergedOnto(repo, ports.calls.sync[0]!, "docs/resolved.md");
    host.runtime.signal(runId, "ar-sync-gate:2", { resolved }, { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" });
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(ports.calls.sync.map((input) => input.resolved)).toEqual([undefined, resolved]);
    expect(summaryOf(run, 2).against.head).toBe(resolved);
  });
});
