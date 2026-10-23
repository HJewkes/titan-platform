import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowStatus } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { factoryMigrations, openFactoryHost, type FactoryHost } from "../host.js";
import { SHEPHERD_MIGRATIONS, factoryRoutesFor } from "../workflows.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { mergeOrderGuard } from "./merge-order-guard.js";
import { MergeOrder, fileRules, type MergeOrderRule, type MergeOrderRules } from "./merge-order.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";
import { ShepherdStore, shepherdStoreRef } from "./store.js";

const REPO = "hjewkes/titan-platform";
const AT = Date.parse("2026-10-23T10:00:00.000Z");
const ON: MergeOrderRules = () => ({ enabled: true, ttlMinutes: 120, ignore: [".changeset/**"] }) satisfies MergeOrderRule;
const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const SHARED = "products/explainer/CAPABILITY.md";
const HEADS = { 2301: fakeSha("order-x"), 2310: fakeSha("order-y") } as const;

interface Rig {
  fake: FakeGitHub;
  port: GitHubPort;
  order: MergeOrder;
  store: ShepherdStore;
  runs: WorkflowRunStore;
  clock: { now: number };
}

const file = (path: string, previousPath?: string): PrFile => ({ path, status: previousPath ? "renamed" : "modified", ...(previousPath && { previousPath }) }) as PrFile;

function running(runs: WorkflowRunStore, id: string, status: WorkflowStatus = "running"): void {
  runs.create({ id, workflowName: "shepherd-pr", params: { repo: REPO }, status, currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: new Date(AT).toISOString(), completedAt: null, error: null });
}

/** #2301 (run-x) holds a reservation on the shared file; #2310 (run-y) is registered and changes `selfFiles`. */
function seed(fake: FakeGitHub, store: ShepherdStore, order: MergeOrder, runs: WorkflowRunStore, selfFiles: PrFile[]): void {
  for (const pr of [2301, 2310] as const) fake.addPr({ number: pr, headSha: HEADS[pr] });
  fake.prFiles.set(2310, selfFiles);
  store.register({ repo: REPO, pr: 2310, runId: "run-y", task: "demo/Y", implementer: "impl-y", policy: AUTO_POLICY });
  running(runs, "run-x");
  order.reserve({ repo: REPO, runId: "run-x", pr: 2301, headSha: HEADS[2301], baseSha: fakeSha("base"), paths: [SHARED, "README.md"], ahead: [], since: new Date(AT).toISOString(), reason: "conflicted" });
}

function rig(selfFiles: PrFile[] = [file(SHARED)]): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [...factoryMigrations(), ...SHEPHERD_MIGRATIONS]);
  const fake = fakeGitHub({ repo: REPO });
  const r = { fake, port: githubPort(fake.wire), order: new MergeOrder(db), store: new ShepherdStore(db), runs: new WorkflowRunStore(db), clock: { now: AT + 60_000 } };
  seed(fake, r.store, r.order, r.runs, selfFiles);
  return r;
}

function reasonFor(r: Rig, options: { rules?: MergeOrderRules; pr?: number; baseRef?: string; branch?: string } = {}): Promise<string | undefined> {
  const guard = mergeOrderGuard({ order: () => r.order, registrations: () => r.store, rules: options.rules ?? ON, now: () => r.clock.now });
  return guard.reason(r.port, REPO, options.pr ?? 2310, options.baseRef ?? "main", HEADS[2310], options.branch ?? "topic-2310");
}

describe("the merge-order guard", () => {
  it("holds a PR that changes a reserved path behind the reserving PR", async () => {
    expect(await reasonFor(rig())).toBe(`merge order: waiting behind #2301 (${SHARED})`);
  });

  it("lets a PR with no reserved path through", async () => {
    expect(await reasonFor(rig([file("src/y.ts")]))).toBeUndefined();
  });

  it("counts a rename's previous path as changed", async () => {
    expect(await reasonFor(rig([file("docs/readme.md", "README.md")]))).toBe("merge order: waiting behind #2301 (README.md)");
  });

  it("stops holding once the reserving PR has merged or closed", async () => {
    const merged = rig();
    merged.fake.pr(2301).merged = true;
    const closed = rig();
    closed.fake.pr(2301).state = "closed";

    expect([await reasonFor(merged), await reasonFor(closed)]).toEqual([undefined, undefined]);
  });

  it("stops holding once the reserving run no longer drives or the reservation passes its TTL", async () => {
    const paused = rig();
    running(paused.runs, "run-paused", "paused");
    paused.order.reserve({ ...paused.order.list(REPO)[0]!, runId: "run-paused" });
    paused.order.release(REPO, "run-x");
    const expired = rig();
    expired.clock.now = AT + 120 * 60_000;

    expect([await reasonFor(paused), await reasonFor(expired)]).toEqual([undefined, undefined]);
  });

  it("never holds a PR behind its own reservation", async () => {
    const r = rig();
    r.order.release(REPO, "run-x");
    r.order.reserve({ repo: REPO, runId: "run-y", pr: 2310, headSha: HEADS[2310], baseSha: fakeSha("base"), paths: [SHARED], ahead: [], since: new Date(AT).toISOString(), reason: "conflicted" });
    running(r.runs, "run-y");

    expect(await reasonFor(r)).toBeUndefined();
  });

  it("never orders a disabled repo, the Version Packages branch, a stacked PR or an unregistered PR", async () => {
    const r = rig();
    r.fake.addPr({ number: 2320, headSha: fakeSha("order-z") });

    const reasons = [await reasonFor(r, { rules: () => ({ enabled: false, ttlMinutes: 120, ignore: [] }) }), await reasonFor(r, { branch: VERSION_PACKAGES_BRANCH }), await reasonFor(r, { baseRef: "topic-2301" }), await reasonFor(r, { pr: 2320 })];

    expect(reasons).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("holds a PR whose changed paths cannot be read until the reservation passes its TTL", async () => {
    const r = rig([file("src/y.ts")]);
    r.fake.prChangedFiles.set(2310, 10_000);

    const before = await reasonFor(r);
    r.clock.now = AT + 120 * 60_000;

    expect(before).toBe("merge order: waiting behind #2301 (this PR's changed paths are unread)");
    expect(await reasonFor(r)).toBeUndefined();
  });

  it("reads nothing at all under the shipped rule file, which leaves every repo unordered", async () => {
    const r = rig();
    r.fake.calls.length = 0;
    const guard = mergeOrderGuard({ order: () => { throw new Error("the store was read"); }, registrations: () => r.store, rules: fileRules, now: () => r.clock.now });

    expect(await guard.reason(r.port, REPO, 2310, "main", HEADS[2310], "topic-2310")).toBeUndefined();
    expect(r.fake.calls).toEqual([]);
  });
});

describe("a merge step behind a merge-order reservation", () => {
  const hosts: FactoryHost[] = [];
  afterEach(() => hosts.splice(0).forEach((host) => host.close()));

  /** Runs #2310's merge step once; the first wait marks #2301 merged, which ends the reservation. */
  async function mergeStep(rules?: MergeOrderRules): Promise<{ fake: FakeGitHub; result: unknown; waits: number }> {
    const fake = fakeGitHub({ repo: REPO });
    const store = shepherdStoreRef();
    let waits = 0;
    const sleep = async () => void (waits++, (fake.pr(2301).merged = true));
    const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => AT + 60_000, sleep, registry: async () => "trusted" as const, ...(rules && { mergeOrderRules: rules }) });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [landPrWorkflow()], routes, gatePollMs: 5 });
    hosts.push(host);
    seed(fake, store.get(), new MergeOrder(host.db), new WorkflowRunStore(host.db), [file(SHARED)]);
    const merge = routes.find((route) => route.match === "merge")!;
    const prompt = JSON.stringify({ repo: REPO, pr: 2310, sha: HEADS[2310], method: "squash", taskIds: [], base: "main" });
    const out = await merge.runner.run({ runId: "run-y", workflowName: "land-pr", stepId: "merge", iteration: 0, prompt, signal: new AbortController().signal, attempt: 0, requestKey: "merge" });
    return { fake, result: out.ok ? (JSON.parse(out.output) as { result: unknown }).result : out, waits };
  }

  it("waits in the merge step and answers held, merging nothing, while an overlapping reservation is live", async () => {
    const { fake, result, waits } = await mergeStep(ON);

    expect(waits).toBe(1);
    expect(result).toMatchObject({ done: false, skipped: "held" });
    expect(fake.effects.merge).toBe(0);
  });

  it("merges at once under the shipped rule file, as it did before merge order existed", async () => {
    const { fake, result, waits } = await mergeStep();

    expect(waits).toBe(0);
    expect(result).toMatchObject({ done: true });
    expect(fake.effects.merge).toBe(1);
  });
});
