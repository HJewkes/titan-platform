import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import { WorkflowRunStore, workflowDefinitionVersionMigration, workflowMigration, workflowOwnershipMigration, type RoutedStepInput, type WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { SHEPHERD_MIGRATIONS, factoryRoutesFor } from "../workflows.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { ReviewerAgent, ReviewerDispatch } from "@titan-design/review-panel";
import { stepName } from "./stats.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";
import { shadowsIn } from "./train-shadow.js";

const REPO = "acme/widgets";
const AT = "2026-09-15T10:00:00.000Z";
const REVIEWER = "rv-shadow";
const HEAD = { 1: fakeSha("readonly-self"), 2: fakeSha("readonly-peer") } as const;

const agent = (name: string, spawnedBy: string | null = "coord"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy, predecessor: null });
const CREW = [agent("coord", null), agent("impl-a"), agent(REVIEWER)];

const dbs: Db[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

function run(pr: number, steps: [string, Record<string, unknown>][], active: string): WorkflowRun {
  const stepResults = Object.fromEntries(steps.map(([key, payload], i) => [key, { stepId: stepName(key), iteration: i, agentId: null, signal: null, completedAt: AT, data: { result: payload } }]));
  const activeSteps = { [active]: { kind: "legacy" as const, stepId: active, iterKey: active, attempt: 1, startedAt: AT } };
  return { id: `run-${pr}`, workflowName: "shepherd-pr", params: { repo: REPO, pr: String(pr) }, status: "running", currentStep: active, stepResults, activeSteps, revision: 0, ownerGeneration: 0, startedAt: AT, completedAt: null, error: null };
}

/** A named-reviewer hold satisfied at the PR's head, by a reviewer independent of its implementer. */
function satisfiedHold(store: ShepherdStoreRef, pr: 1 | 2): void {
  const runId = `run-${pr}`;
  store.get().register({ repo: REPO, pr, runId, task: `demo/${pr}`, implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.get().recordAuthor(runId, { agentId: "agent-impl-a", name: "impl-a", role: "implementer" });
  store.get().hold(runId, "awaiting a named review", REVIEWER);
  store.get().satisfyHold(runId, REVIEWER, HEAD[pr], { agentId: `agent-${REVIEWER}`, sessionId: `session-${REVIEWER}`, locator: {} });
}

/**
 * The routes as production wires them, with a reviewer whose transcript read fails. A writing hold check withdraws a
 * satisfaction at the head it reads on such a failure, so any shadow read through one shows up in the registrations.
 */
function scene() {
  const db = openDatabase(":memory:");
  dbs.push(db);
  runMigrations(db, [workflowMigration(1), workflowOwnershipMigration(2), workflowDefinitionVersionMigration(3), ...SHEPHERD_MIGRATIONS]);
  const fake = fakeGitHub({ repo: REPO });
  for (const pr of [1, 2] as const) fake.addPr({ headSha: HEAD[pr] });
  const store = shepherdStoreRef(() => Date.parse(AT));
  const reader = { read: async () => Promise.reject(new Error("transcript unreadable")) };
  const dispatch = partialFake<ReviewerDispatch>({ roster: async () => CREW });
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => Date.parse(AT), sleep: async () => undefined, review: { reader, dispatch } });
  routes.database?.bind(db);
  const runs = new WorkflowRunStore(db);
  runs.create(run(1, [["ci-wait:0", { verdict: "behind", headSha: HEAD[1], checksGreen: true, baseMoved: true }]], "update-branch:0"));
  runs.create(run(2, [["ci-wait:0", { verdict: "green", headSha: HEAD[2] }]], "merge:0"));
  satisfiedHold(store, 1);
  satisfiedHold(store, 2);
  return { db, store, update: routes.find((route) => route.match === "update-branch")! };
}

const refresh = (pr: number): RoutedStepInput => ({ runId: `run-${pr}`, workflowName: "shepherd-pr", stepId: "update-branch:0", iteration: 0, prompt: JSON.stringify({ repo: REPO, pr, expectedHeadSha: HEAD[1] }), signal: new AbortController().signal, attempt: 1, requestKey: `k-${pr}` });

describe("the train shadow's hold read", () => {
  it("leaves the refreshing run's and each peer's hold as it found them", async () => {
    const s = scene();
    const before = [1, 2].map((pr) => s.store.get().byPr(REPO, pr));

    await s.update.runner.run(refresh(1));

    expect(shadowsIn(s.db)).toHaveLength(1);
    expect([1, 2].map((pr) => s.store.get().byPr(REPO, pr))).toEqual(before);
    expect(before.map((registration) => registration?.holdSatisfied?.head)).toEqual([HEAD[1], HEAD[2]]);
  });
});
