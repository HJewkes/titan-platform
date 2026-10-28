import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { GateResolver } from "@titan-design/hitl";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import { decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523 } from "./merge-facts.js";
import { PlanApprovalRefused, type PlanApproval } from "./plan-approval.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore, type RegistrationInput } from "./store.js";

const REPO = "example-org/example-repo";
const TASK = "example/TP-1";
const SKILL_FILE = ".claude/skills/x/SKILL.md";
const CONSOLE = (confirmEvent: string): GateResolver => ({ class: "owner-remote", id: "titan-console", channel: "console:inbox", confirmEvent });
const SKILL: PlanApproval = { gate: "skill", scope: { paths: [SKILL_FILE] }, round: "round-1" };
const CI_POLICY: PlanApproval = { gate: "ci-policy", scope: { ciPolicyKeys: ["other"], files: [{ path: ".github/merge-lint.json", blob: "a".repeat(40) }, { path: ".github/old.yml", blob: null }] }, round: "round-1" };
const REGISTRATION: RegistrationInput = { repo: REPO, pr: 1, runId: "run-1", task: TASK, implementer: "impl-a", policy: OWNER_GATE_POLICY };

function openStore(): { store: ShepherdStore; db: Db } {
  const db = openDatabase(":memory:");
  runMigrations(db, SHEPHERD_MIGRATIONS);
  return { store: new ShepherdStore(db, () => Date.parse("2026-10-28T12:00:00Z")), db };
}

const approve = (store: ShepherdStore, approval: PlanApproval = SKILL, confirmEvent = "action:1", claimRun?: string) => store.planApprovals().record({ ...approval, task: TASK, repo: REPO }, CONSOLE(confirmEvent), claimRun);
const rowCount = (db: Db): number => (db.prepare("SELECT count(*) AS n FROM shepherd_plan_approval").get() as { n: number }).n;

describe("the plan-approval store", () => {
  it("writes one row per console confirmation and reports a repeat of the same confirm event as already written", () => {
    const { store, db } = openStore();

    const first = approve(store, CI_POLICY);
    const repeat = approve(store, CI_POLICY);

    expect([first, repeat]).toEqual([true, false]);
    expect(rowCount(db)).toBe(1);
  });

  it.each<[string, GateResolver]>([
    ["a coordinator", { class: "coordinator", id: "tc-synthetic", channel: "factory-cli", confirmEvent: "action:1" }],
    ["the owner's terminal", { class: "owner-terminal", id: "titan-console", channel: "factory-cli", confirmEvent: "action:1" }],
    ["the console without a confirm event", { class: "owner-remote", id: "titan-console", channel: "console:inbox" }],
  ])("refuses a write from %s and leaves no row", (_case, resolver) => {
    const { store, db } = openStore();

    expect(() => store.planApprovals().record({ ...SKILL, task: TASK, repo: REPO }, resolver)).toThrow(PlanApprovalRefused);
    expect(rowCount(db)).toBe(0);
  });

  it("never reads back a row an agent inserted directly, even one claimed by the run", () => {
    const { store, db } = openStore();
    store.register(REGISTRATION);
    const insert = "INSERT INTO shepherd_plan_approval (confirm_event, task, repo, gate, scope, round, actor, claimed_run, answered_at) VALUES ('forged', ?, ?, 'skill', ?, 'round-1', 'agent:x', 'run-1', 't')";
    db.prepare(insert).run(TASK, REPO, JSON.stringify(SKILL.scope));

    expect(store.planApprovals().forRun("run-1", TASK, REPO)).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["the old line-entry scope", { paths: [SKILL_FILE], ciPolicyKeys: ["other"], entries: [{ path: ".github/x.yml", side: "+", n: 1, text: "x" }] }],
    ["empty files", { ciPolicyKeys: ["other"], files: [] }],
    ["empty CI-policy keys", { ciPolicyKeys: [], files: [{ path: ".github/x.yml", blob: "a".repeat(40) }] }],
    ["a blob that is not 40-hex", { ciPolicyKeys: ["other"], files: [{ path: ".github/x.yml", blob: "A".repeat(40) }] }],
    ["a path pinned twice", { ciPolicyKeys: ["other"], files: [{ path: ".github/x.yml", blob: null }, { path: ".github/x.yml", blob: "a".repeat(40) }] }],
  ])("refuses a ci-policy approval with %s and leaves no row", (_case, scope) => {
    const { store, db } = openStore();

    expect(() => approve(store, { gate: "ci-policy", scope, round: "round-1" } as PlanApproval)).toThrow();
    expect(rowCount(db)).toBe(0);
  });

  it("refuses a skill approval with no paths", () => {
    const { store, db } = openStore();

    expect(() => approve(store, { gate: "skill", scope: { paths: [] }, round: "round-1" })).toThrow();
    expect(rowCount(db)).toBe(0);
  });
});

describe("binding a plan approval to one run", () => {
  it("lets a registration made after the approval claim it, and a second PR registered under the task later reads none", () => {
    const { store } = openStore();
    approve(store, CI_POLICY);

    store.register(REGISTRATION);
    store.register({ ...REGISTRATION, pr: 2, runId: "run-2" });

    expect(store.planApprovals().forRun("run-1", TASK, REPO)).toEqual([CI_POLICY]);
    expect(store.planApprovals().forRun("run-2", TASK, REPO)).toEqual([]);
  });

  it("reads none for a claimed run once it is re-registered under another task, and none for a run updated to the approved task", () => {
    const { store } = openStore();
    approve(store, SKILL, "action:1");
    store.register(REGISTRATION);
    store.register({ ...REGISTRATION, pr: 2, runId: "run-2", task: "example/TP-2" });

    store.update("run-1", { ...REGISTRATION, task: "example/TP-3" });
    store.update("run-2", { ...REGISTRATION, pr: 2 });
    approve(store, SKILL, "action:2");
    store.update("run-2", { ...REGISTRATION, pr: 2 });

    expect(store.planApprovals().forRun("run-1", "example/TP-3", REPO)).toEqual([]);
    expect(store.planApprovals().forRun("run-2", TASK, REPO)).toEqual([]);
  });

  it("moves a run's claims to the run that replaces it", () => {
    const { store } = openStore();
    approve(store, SKILL);
    store.register(REGISTRATION);

    store.repoint("run-1", "run-1b");

    expect(store.planApprovals().forRun("run-1", TASK, REPO)).toEqual([]);
    expect(store.planApprovals().forRun("run-1b", TASK, REPO)).toEqual([SKILL]);
  });
});

describe("the merge guard before plan approvals are honoured", () => {
  const HEAD = fakeSha("plan-approval-head");
  const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
  const locator: SourceTextLocator = {
    source: {
      ...{ sourceId: "transcript-1", harness: "claude-code", format: "jsonl", formatVersion: null, path: "transcripts/transcript-1.jsonl", namespace: "test" },
      ...{ conversation: { harness: "claude-code", namespace: "test", nativeId: "session-rv-1" }, provenance: { kind: "native", name: "test" } },
    },
    evidence: { line: { sourceId: "transcript-1", byteOffset: 0, byteLength: 1, contentHash: "0".repeat(64), lineNumber: 1, nativeOrdinal: null }, subrecord: { index: 0, path: [] } },
    selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
  };

  it("still gates a skill change at skill-path when the run holds a claimed skill approval for that path", async () => {
    const { store } = openStore();
    approve(store, SKILL);
    store.register(REGISTRATION);
    const fake = fakeGitHub();
    fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
    fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
    fake.prFiles.set(1, [{ path: SKILL_FILE, status: "added" }]);
    const input = { runId: "run-1", repo: REPO, pr: 1, head: HEAD, verdict: { value: "MERGE" as const, head: HEAD, locator }, resolver: REVIEWER, dispatchedReviewer: REVIEWER, seatGrants: ["merge-on-green-approve" as const] };

    const evidence = await mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "correctness" });

    expect(store.planApprovals().forRun("run-1", TASK, REPO)).toEqual([SKILL]);
    expect(decideAutoMerge(HEAD, evidence)).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "skill-path" } });
  });
});
