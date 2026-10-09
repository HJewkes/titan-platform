import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import type { RoutedStepInput } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { factoryRoutesFor } from "../workflows.js";
import { shepherdEventMigration } from "./events.js";
import { FREEZE_RECHECK_MS, freezeCancelOnlyMigration, freezeMigration, freezeStoreRef, type FreezeStore } from "./freeze.js";
import { MERGE_EVIDENCE_STEP, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { EffectivePolicy } from "./policy.js";
import type { ReviewerReader } from "./review.js";
import { holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration, type ShepherdStore } from "./store.js";

const REPO = "octo/demo";
const RED = fakeSha("freeze-policy-red");
const GREEN = fakeSha("freeze-policy-green");
const FIX_TASK = "demo/FIX-1";
const FIXER = "fix-demo-red";
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" };
const locator = { sourceId: "transcript-1", selector: { kind: "subrecord-text" } } as unknown as SourceTextLocator;

const dbs: Db[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

interface Scene {
  fake: FakeGitHub;
  freezes: FreezeStore;
  registrations: ShepherdStore;
  clock: { at: number };
  /** The production sh-merge-evidence route, with the default freeze reader `factoryRoutesFor` wires. */
  evidence: (pr: number) => Promise<MergeEvidence>;
}

function scene(): Scene {
  const db = openDatabase(":memory:");
  dbs.push(db);
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), freezeMigration(6), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), freezeCancelOnlyMigration(12), shepherdEventMigration(16)]);
  const store = shepherdStoreRef();
  const freeze = freezeStoreRef();
  store.bind(db);
  freeze.bind(db);
  const fake = fakeGitHub();
  const clock = { at: 0 };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, freeze, now: () => clock.at, sleep: async () => undefined, review: { reader: {} as ReviewerReader } });
  const route = routes.find((candidate) => candidate.match === MERGE_EVIDENCE_STEP)!;
  const evidence = async (pr: number) => {
    const head = fake.pr(pr).headSha;
    const input: MergeEvidenceInput = { runId: `run-${pr}`, repo: REPO, pr, head, verdict: { value: "MERGE", head, locator }, resolver: REVIEWER, dispatchedReviewer: REVIEWER, seatGrants: ["merge-on-green-approve"] };
    const outcome = await route.runner.run({ prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: 0, requestKey: `k-${pr}` } as unknown as RoutedStepInput);
    if (!outcome.ok) throw new Error(outcome.error);
    return (JSON.parse(outcome.output) as { result: MergeEvidence }).result;
  };
  return { fake, freezes: freeze.get(), registrations: store.get(), clock, evidence };
}

/** A green, cleanly mergeable PR registered under `task` by `implementer`. */
function openPr(s: Scene, task: string, implementer: string): number {
  const headSha = fakeSha(`freeze-policy-${task}-${implementer}`);
  const { number } = s.fake.addPr({ headSha, mergeSha: fakeSha(`freeze-policy-merge-${headSha}`) });
  s.fake.setRuns(headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  s.fake.prFiles.set(number, [{ path: "src/a.ts", status: "modified" }]);
  s.registrations.register({ repo: REPO, pr: number, runId: `run-${number}`, task, implementer, policy: AUTO, kind: "correctness" });
  return number;
}

function frozenWithFixer(s: Scene): number {
  const { episode } = s.freezes.freeze(REPO, RED);
  s.freezes.setFixTask(REPO, episode, FIX_TASK);
  s.freezes.setFixer(REPO, episode, FIXER);
  return episode;
}

const RV_ALLOW = { outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV" } };

describe("repo-not-frozen in merge policy while the repo is frozen", () => {
  it("is met for the freeze's own fix PR, which merges by MRG-AU-RV", async () => {
    const s = scene();
    const fix = openPr(s, FIX_TASK, FIXER);
    frozenWithFixer(s);

    const evidence = await s.evidence(fix);

    expect(evidence.merge.repoFrozen).toBe(false);
    expect(evidence.record.decision).toMatchObject(RV_ALLOW);
  });

  it("still gates a sibling PR in the same frozen repo", async () => {
    const s = scene();
    openPr(s, FIX_TASK, FIXER);
    const sibling = openPr(s, "demo/OTHER-2", "impl-b");
    frozenWithFixer(s);

    const evidence = await s.evidence(sibling);

    expect(evidence.merge.repoFrozen).toBe(true);
    expect(evidence.record.decision.outcome).toBe("gate");
    expect(evidence.record.decision.reason).toContain("repo-not-frozen");
  });

  it.each([
    ["names the fix task but another implementer", FIX_TASK, "impl-b"],
    ["names the fixer on another task", "demo/OTHER-2", FIXER],
  ])("still gates a PR that %s", async (_name, task, implementer) => {
    const s = scene();
    const pr = openPr(s, task, implementer);
    frozenWithFixer(s);

    const evidence = await s.evidence(pr);

    expect(evidence.merge.repoFrozen).toBe(true);
    expect(evidence.record.decision.outcome).toBe("gate");
  });

  it("still gates the fix task's PR before the freeze names a fixer", async () => {
    const s = scene();
    const pr = openPr(s, FIX_TASK, FIXER);
    const { episode } = s.freezes.freeze(REPO, RED);
    s.freezes.setFixTask(REPO, episode, FIX_TASK);

    expect((await s.evidence(pr)).merge.repoFrozen).toBe(true);
  });
});

describe("repo-not-frozen in merge policy once the repo has thawed", () => {
  it("is met for every PR, the former fix PR and its sibling alike", async () => {
    const s = scene();
    const fix = openPr(s, FIX_TASK, FIXER);
    const sibling = openPr(s, "demo/OTHER-2", "impl-b");
    frozenWithFixer(s);
    s.freezes.unfreeze(REPO, GREEN);

    for (const pr of [fix, sibling]) {
      const evidence = await s.evidence(pr);
      expect(evidence.merge.repoFrozen).toBe(false);
      expect(evidence.record.decision).toMatchObject(RV_ALLOW);
    }
  });
});

/** Main moves from the red sha to a green child of it, as a merge outside Shepherd would leave it. */
function mainFixedOutsideShepherd(s: Scene): void {
  s.fake.commits.set(GREEN, { sha: GREEN, parents: [RED], tree: fakeSha("freeze-policy-green-tree") });
  s.fake.refs.set("main", GREEN);
  s.fake.setRuns(GREEN, [successRun("validate", 1), successRun("dag-check", 2)]);
}

const mainReads = (s: Scene): number => s.fake.calls.filter((call) => call === "getRef").length;

describe("repo-not-frozen in merge policy once main went green outside Shepherd", () => {
  it("thaws the stale freeze before deciding, so a MERGE verdict merges by MRG-AU-RV with no approve-merge gate", async () => {
    const s = scene();
    const pr = openPr(s, "demo/OTHER-2", "impl-b");
    s.freezes.freeze(REPO, RED);
    mainFixedOutsideShepherd(s);

    const evidence = await s.evidence(pr);

    expect(evidence.merge.repoFrozen).toBe(false);
    expect(evidence.record.decision).toMatchObject(RV_ALLOW);
    expect(s.freezes.isFrozen(REPO)).toBe(false);
  });

  it("stays frozen and gates when the read of main fails", async () => {
    const s = scene();
    const pr = openPr(s, "demo/OTHER-2", "impl-b");
    s.freezes.freeze(REPO, RED);
    mainFixedOutsideShepherd(s);
    s.fake.wire.getRef = async () => {
      throw new Error("github unavailable");
    };

    const evidence = await s.evidence(pr);

    expect(evidence.merge.repoFrozen).toBe(true);
    expect(evidence.record.decision.outcome).toBe("gate");
    expect(s.freezes.isFrozen(REPO)).toBe(true);
  });

  it("reads main once for two decisions inside five minutes, and again after", async () => {
    const s = scene();
    const pr = openPr(s, "demo/OTHER-2", "impl-b");
    s.freezes.freeze(REPO, RED);

    await s.evidence(pr);
    mainFixedOutsideShepherd(s);
    s.clock.at += FREEZE_RECHECK_MS - 1;
    const early = await s.evidence(pr);
    const readsInsideWindow = mainReads(s);
    s.clock.at += 1;
    const later = await s.evidence(pr);

    expect(readsInsideWindow).toBe(1);
    expect(early.merge.repoFrozen).toBe(true);
    expect(later.merge.repoFrozen).toBe(false);
  });
});
