import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GhExec } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { ReviewerAgent } from "@titan-design/review-panel";
import { partialFake } from "@titan-design/test-kit";
import { WorkflowRunStore, type RoutedStepInput, type WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { factoryMigrations } from "../host.js";
import { fakeLocator } from "../test-support/fakes.js";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import { attestJudge } from "./attest-evidence.js";
import { attestationsFileOf, LEGACY_ATTESTATIONS_PATH } from "./attest-read.js";
import { deploySkew } from "./attest-skew.js";
import { carriedVerdict, carryRoutes } from "./carry-merge.js";
import { headWaits } from "./freeze-wait.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import { mergeOrderGuard } from "./merge-order-guard.js";
import { MergeOrder, type MergeOrderRules } from "./merge-order.js";
import type { Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { ReviewerAskTimedOut } from "./review-wait.js";
import { ShepherdStore, type Registration, type ShepherdStoreRef } from "./store.js";
import type { CarryResult } from "./tree-carry.js";

/*
 * Production-shaped smoke for the four 11-02/03 attest defects. The fixtures copy the field shapes of the broker's
 * `agent ls --json --include-retired` (finished and retired rows, predecessor null, reviewers spawned by "human", and no
 * "human" row, since nothing spawned the broker principal) and the shape of a PR that claims one ci-wait row beside a
 * stacked child. Names, ids and numbers are synthetic.
 */

const REPO = "octo/demo";
const HEAD = fakeSha("smoke-head");
const closure = (seed: string) => fakeSha(`closure-${seed}`) + fakeSha(`closure-${seed}-tail`).slice(0, 24);
const CI_WAIT = { step: "ci-wait", closure: closure("ci-wait"), pr: 1 };
const OLD_ROW = { step: "ci-wait", closure: closure("older"), pr: 2 };
const token = (row: { step: string; closure: string }) => `${row.step}@${row.closure.slice(0, 12)}`;

const row = (name: string, spawnedBy: string | null, presence: ReviewerAgent["presence"]): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy, predecessor: null });
const roster: readonly ReviewerAgent[] = [
  row("impl-a", "human", "exited"),
  row("rev-1", "human", "deregistered"),
  row("rev-old", "human", "exited"),
  row("fix-1", "impl-a", "exited"),
];
const identity = (name: string) => ({ agentId: `agent-${name}`, sessionId: `session-${name}` });

/** A PR whose head claims one new ci-wait row against the base. */
function claimingWorld(): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("smoke-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [{ path: attestationsFileOf(1), status: "added" }]);
  for (const ref of ["main", HEAD]) fake.files.set(`${ref}:${attestationsFileOf(2)}`, { content: JSON.stringify([OLD_ROW]), blobSha: "b-old" });
  fake.files.set(`${HEAD}:${attestationsFileOf(1)}`, { content: JSON.stringify([CI_WAIT]), blobSha: "b-head" });
  return fake;
}

const request = (reviewer: string): MergeEvidenceInput => ({
  runId: "run-1",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  resolver: identity(reviewer),
  dispatchedReviewer: identity(reviewer),
  seatGrants: ["merge-on-green-approve"],
  attest: { attests: [token(CI_WAIT)] },
});

const registration = partialFake<Registration>({ runId: "run-1", implementer: "impl-a", holdReason: null, held: false, kind: "correctness" });
const store = partialFake<ShepherdStoreRef>({ get: () => partialFake<ShepherdStore>({ byRun: () => registration, authorsOf: () => [] }) });

interface Brokerage {
  lineage: () => Promise<{ rows: readonly ReviewerAgent[]; complete: boolean }>;
  budgetMs: number;
}

/** The evidence step's judgement of a ci-wait claim, with the broker's reads on a fake clock that `sleep` advances. */
async function judged(reviewer: string, { lineage, budgetMs }: Brokerage) {
  const fake = claimingWorld();
  const port = githubPort(fake.wire);
  let clock = 0;
  const timing = { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 5_000, brokerDownWaitMs: 15 * 60_000 };
  const judge = attestJudge(port, store, { dispatch: { roster: async () => roster }, lineage }, { timing, budgetMs, signal: new AbortController().signal });
  return mergeEvidence(port, request(reviewer), noFreezeStoreUntilTp523, { kind: "correctness" }, undefined, { attest: judge });
}

const wholeRoster = async () => ({ rows: roster, complete: true });

describe("attest smoke: production-shaped roster and a ci-wait claim", () => {
  it("TP-4731: a lineage read that times out at the 90 s call limit and answers inside the budget still judges, and does not gate unread", async () => {
    let reads = 0;
    const slowOnce = async () => (++reads === 1 ? Promise.reject(new ReviewerAskTimedOut("lineage read timed out after 90 s")) : wholeRoster());

    const result = await judged("rev-1", { lineage: slowOnce, budgetMs: 6 * 60_000 });

    expect(reads).toBe(2);
    expect(result.record.attested).toEqual([{ step: "ci-wait", closure: CI_WAIT.closure, meeters: [{ name: "rev-1", agentId: "agent-rev-1", shape: "correctness" }] }]);
    expect(result.record.attestUnmet).toEqual([]);
    expect(result.record.decision).toMatchObject({ outcome: "allow" });
  });

  it("TP-4738: a reviewer Shepherd spawned as the human meets the ci-wait row although the roster has no human row", async () => {
    expect(roster.some((agent) => agent.name === "human")).toBe(false);

    const result = await judged("rev-1", { lineage: wholeRoster, budgetMs: 6 * 60_000 });

    expect(result.record.attested).toMatchObject([{ step: "ci-wait", meeters: [{ name: "rev-1" }] }]);
    expect(result.record.attestUnmet).toEqual([]);
  });

  it("TP-4738: the implementer's own fixer still does not meet the row", async () => {
    const result = await judged("fix-1", { lineage: wholeRoster, budgetMs: 6 * 60_000 });

    expect(result.record).toMatchObject({ attested: [], attestUnmet: [{ step: "ci-wait", why: "meeter-is-author" }] });
  });
});

describe("attest smoke: carrying a MERGE onto a head that claims a row", () => {
  const REVIEWED = fakeSha("smoke-reviewed");
  const MERGE_UP: CarryResult = { equal: true, base: fakeSha("main"), headTree: "tree-a", mergeTree: "tree-a", firstParent: REVIEWED };
  const AGENT = { agentId: "rv-1", sessionId: "s-1" };
  const merged = partialFake<Verdict>({
    kind: "MERGE",
    headSha: REVIEWED,
    evidence: { head: REVIEWED, merge: { head: REVIEWED, verdict: { value: "MERGE", head: REVIEWED }, resolver: AGENT, dispatchedReviewer: AGENT, seatGrants: ["merge-on-green-approve"] }, record: { verdictLocator: { sourceId: "synthetic" } } },
  });

  /** A context whose claims step is the real route reading the fake GitHub; every other step answers as a clean merge-up. */
  function carryCtx(fake: FakeGitHub): { ctx: WorkflowContext; asked: string[] } {
    const route = carryRoutes({ now: () => 0, port: githubPort(fake.wire), store: partialFake<ShepherdStoreRef>() }, undefined).find((r) => r.match === "sh-carry-claims")!;
    const asked: string[] = [];
    const answer = async (stepId: string, input: Record<string, unknown>): Promise<object> => {
      if (stepId.startsWith("sh-carry-scope")) return { kind: "correctness", baseRef: "main" };
      if (stepId.startsWith("sh-carry-claims:")) {
        const outcome = await route.runner.run(partialFake<RoutedStepInput>({ prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: 0, requestKey: "k" }));
        if (!outcome.ok) throw new Error(outcome.error);
        return z.object({ result: z.record(z.string(), z.unknown()) }).parse(JSON.parse(outcome.output)).result;
      }
      if (stepId.startsWith("sh-carry:")) return MERGE_UP;
      if (stepId.startsWith("sh-carry-seat:")) return { clear: true };
      if (stepId.startsWith("sh-publish-review:")) return { published: false };
      return { head: input.head, merge: {}, record: {} };
    };
    const dispatch = async (stepId: string, _template: string, options: { vars: Record<string, string> }) => {
      asked.push(stepId);
      const input = z.record(z.string(), z.unknown()).parse(JSON.parse(Object.values(options.vars)[0]!));
      return { data: { result: await answer(stepId, input) } };
    };
    return { ctx: Object.assign(partialFake<WorkflowContext>(), { runId: "run-1", dispatch, historyNext: () => undefined, param: () => undefined }), asked };
  }

  it("TP-4740: a clean merge-main onto a head claiming a ci-wait row asks a fresh review instead of carrying", async () => {
    const { ctx, asked } = carryCtx(claimingWorld());

    const verdict = await carriedVerdict(ctx, { repo: REPO, pr: 1 }, new Map([[REVIEWED, merged]]), HEAD, 0);

    expect(verdict).toBeUndefined();
    expect(asked.some((id) => id.startsWith("sh-carry-claims:"))).toBe(true);
    expect(asked.some((id) => id.startsWith("sh-merge-evidence"))).toBe(false);
  });
});

describe("attest smoke: a stacked PR's merge-order reservation", () => {
  const AT = Date.parse("2026-10-23T10:00:00.000Z");
  const ON: MergeOrderRules = () => ({ enabled: true, ttlMinutes: 120, ignore: [".changeset/**"] });
  const POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
  const SHARED = "products/demo/CAPABILITY.md";
  const STACKED = 3194;
  const MAIN_BASED = 3188;

  it("TP-4741: a PR stacked on another branch reserves a path, and the main-based PR changing it is not ordered behind it", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [...factoryMigrations(), ...SHEPHERD_MIGRATIONS]);
    const fake = fakeGitHub({ repo: REPO });
    fake.addPr({ number: STACKED, headSha: fakeSha("stacked") });
    fake.addPr({ number: MAIN_BASED, headSha: fakeSha("main-based") });
    fake.pr(STACKED).baseRef = "topic-parent";
    fake.prFiles.set(MAIN_BASED, [{ path: SHARED, status: "modified" }, { path: attestationsFileOf(MAIN_BASED), status: "added" }]);
    const shepherd = new ShepherdStore(db);
    const runs = new WorkflowRunStore(db);
    shepherd.register({ repo: REPO, pr: MAIN_BASED, runId: "run-main", task: "demo/A", implementer: "impl-a", policy: POLICY });
    runs.create({ id: "run-stacked", workflowName: "shepherd-pr", params: { repo: REPO }, status: "running", currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: new Date(AT).toISOString(), completedAt: null, error: null });
    const order = new MergeOrder(db);
    order.reserve({ repo: REPO, runId: "run-stacked", pr: STACKED, headSha: fakeSha("stacked"), baseSha: fakeSha("base"), paths: [SHARED], ahead: [], since: new Date(AT).toISOString(), reason: "conflicted" });
    const guard = mergeOrderGuard({ order: () => order, registrations: () => shepherd, rules: ON, now: () => AT + 60_000 });

    const reason = await guard.reason(githubPort(fake.wire), REPO, MAIN_BASED, "main", fakeSha("main-based"), "topic-main-based");

    expect(reason).toBeUndefined();
  });
});

describe("attest smoke: main holds a registry commit the running build lacks", () => {
  const BUILD = fakeSha("running-build");
  const DEPLOYED = fakeSha("deployed-build");
  const LAYOUT_COMMIT = ["products/factory/src/registry/attestations.json", "products/factory/src/registry/attestations/2.json"];

  /** The reads a build without the per-PR reader made on 11-03: main's deleted legacy file reads [], the head's stale copy every row. */
  function skewedWorld(): FakeGitHub {
    const fake = fakeGitHub();
    fake.addPr({ headSha: HEAD, mergeSha: fakeSha("smoke-merge") });
    fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
    fake.prFiles.set(1, [{ path: LEGACY_ATTESTATIONS_PATH, status: "modified" }]);
    fake.files.set(`${HEAD}:${LEGACY_ATTESTATIONS_PATH}`, { content: JSON.stringify([OLD_ROW, CI_WAIT]), blobSha: "b-legacy" });
    return fake;
  }

  /** `gh compare <sha>...main`: one layout commit ahead of the running build, none ahead of the deployed one. */
  const compare: GhExec = async (args) => ({ code: 0, stdout: args.some((arg) => arg.includes(DEPLOYED)) ? "0\n0\n" : `1\n${LAYOUT_COMMIT.length}\n${LAYOUT_COMMIT.join("\n")}\n`, stderr: "" });

  async function judgedOn(build: string) {
    const fake = skewedWorld();
    const port = githubPort(fake.wire);
    const timing = { now: () => 0, sleep: async () => undefined, pollMs: 5_000, brokerDownWaitMs: 15 * 60_000 };
    const skew = deploySkew({ sha: build, repo: REPO, exec: compare });
    const judge = attestJudge(port, store, { dispatch: { roster: async () => roster }, lineage: wholeRoster, deploySkew: skew }, { timing, budgetMs: 60_000, signal: new AbortController().signal });
    return mergeEvidence(port, request("rev-1"), noFreezeStoreUntilTp523, { kind: "correctness" }, undefined, { attest: judge });
  }

  it("TP-4752: case 5, the attest step waits under a named reason, re-read each round, and raises no closure-mismatch gate", async () => {
    const result = await judgedOn(BUILD);

    expect(result.record.attestWaiting).toMatch(/^deploy skew: main is 1 commit\(s\) ahead of build .*registry/);
    expect(result.record.attestUnmet).toBeUndefined();
    expect(result.record.decision).toMatchObject({ outcome: "gate", rule: { rowId: "attest-deploy-skew" } });
    expect(result.record.decision.reason).not.toContain("closure-mismatch");
    const waits = headWaits(async () => undefined);
    expect(waits.transient(result.record.decision)).toBe(true);
    expect(waits.kind?.(result.record.decision)).toBe("thaw");
  });

  it("TP-4752: once the deploy holds main's registry commits, the same head is judged as before", async () => {
    const result = await judgedOn(DEPLOYED);

    expect(result.record.attestWaiting).toBeUndefined();
    expect(result.record.attestUnmet).toEqual([{ step: "ci-wait", why: "closure-mismatch" }]);
    expect(result.record.decision).toMatchObject({ outcome: "gate", rule: { rowId: "attest-unmet" } });
  });
});
