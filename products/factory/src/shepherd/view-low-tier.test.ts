import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { LOW_TIER_RULE } from "./g10-release.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { applyRegistrationHold } from "./registration-hold.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";
import { timelineEntries } from "./view.js";

const HEAD = fakeSha("view-low-tier-head");
const RELEASE_STEP = `sh-g10-release:${HEAD}:0`;
const AT = "2026-01-01T01:00:00.000Z";

/** A completed run whose only step is `stepId`, recorded with `result`. */
function completedWith(stepId: string, result: object): WorkflowRun {
  const stepResult = { stepId, iteration: 0, completedAt: AT, signal: null, data: { result } };
  return Object.assign(partialFake<WorkflowRun>(), { id: "run-1", status: "completed", currentStep: null, activeSteps: {}, stepResults: { [stepId]: stepResult } });
}

const released = { released: true, head: HEAD, rule: LOW_TIER_RULE, reviewerProfile: "bd-reviewer", verdict: { value: "MERGE", head: HEAD, reviewer: { agentId: "rev-1", sessionId: "s-1" }, locator: {} } };

/** The hold events of a run registered on a PR whose one file is `path`. */
async function holdEventsFor(path: string) {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: "octo/demo" });
  const { number: pr } = fake.addPr({ headSha: HEAD });
  fake.prFiles.set(pr, [{ path, status: "modified", additions: 10, deletions: 0 }]);
  store.register({ repo: "octo/demo", pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "feature" });
  await applyRegistrationHold(githubPort(fake.wire), store, "run-1");
  return store.eventsOf("run-1");
}

describe("the low-tier decision on the timeline", () => {
  it("the timeline shows the low-tier release with its head, reviewer and rule", () => {
    expect(timelineEntries(completedWith(RELEASE_STEP, released), [])).toEqual([{ kind: "decision", stepId: RELEASE_STEP, rule: LOW_TIER_RULE, head: HEAD, reviewer: "rev-1", profile: "bd-reviewer" }]);
  });

  it("a release that was refused stays a plain step", () => {
    expect(timelineEntries(completedWith(RELEASE_STEP, { released: false, head: HEAD }), [])).toEqual([expect.objectContaining({ kind: "step", stepId: RELEASE_STEP })]);
  });

  it("the timeline shows the kept reason when a policy touch stays adversary", async () => {
    const events = await holdEventsFor("packages/queue-mirror/src/mirror.ts");

    expect(timelineEntries(completedWith("sh-start", {}), [], events)).toContainEqual(expect.objectContaining({ kind: "event", event: "hold", reason: "g10-adversary: policy touch (kept: gate-resolve-actor)", actor: "shepherd" }));
  });
});
