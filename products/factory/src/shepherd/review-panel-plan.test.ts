import { fakeGitHub, githubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdEventMigration } from "./events.js";
import type { PrFilesRead } from "./git-pr-files.js";
import { holdSlotsMigration, registrationFactsMigration } from "./store-migrations.js";
import { spawnFacts } from "./spawn-facts.js";
import { holdReviewerMigration, holdSatisfiedMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";
import { DEFAULT_ADVERSARY_PROFILE, classRulesFor, intentPlan, panelFacts, panelPolicyFor, withoutPlan, type PanelFacts } from "./review-panel-plan.js";

const HEAD = "c".repeat(40);
const target = { repo: "octo/demo", pr: 7, head: HEAD };

const source = (path: string, lines: number): PrFile => ({ path, status: "modified", additions: lines, deletions: 0 });

/** A real store with the run registered under `kind`, or an unbound one that cannot be read; PR 7's files on a fake GitHub, or a list GitHub truncated. */
function depsWith(registered: { kind?: string } | "unreadable", files: PrFile[] | "truncated") {
  const store = shepherdStoreRef();
  if (registered !== "unreadable") {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
    store.bind(db);
    store.get().register({ repo: target.repo, pr: target.pr, runId: "run-1", task: "titan-platform/TP-1", implementer: "impl-a", policy: OWNER_GATE_POLICY, ...registered });
  }
  const fake = fakeGitHub();
  fake.prFiles.set(target.pr, files === "truncated" ? [source("src/a.ts", 1)] : files);
  if (files === "truncated") fake.prChangedFiles.set(target.pr, 3_001);
  return { store, port: githubPort(fake.wire) };
}

const facts = (kind: string | undefined, files: PrFile[], sizeUnread = false): PanelFacts => ({
  facts: { ...target, base: "", ...(kind !== undefined && { kind }), changedFiles: files.map(({ path, additions, deletions }) => ({ path, additions: additions ?? Number.NaN, deletions: deletions ?? Number.NaN })) },
  sizeUnread,
});
const shapes = (planned: ReturnType<typeof intentPlan>) => planned.plan.members.map((member) => `${member.shape}:${member.profile}`);

/** A store whose run names `base`, a GitHub whose list must not be read, and a git reader answering per head. */
function gitDeps(base: string | undefined, byHead: Record<string, PrFile[]>) {
  const store = shepherdStoreRef();
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), registrationFactsMigration(24)]);
  store.bind(db);
  store.get().register({ repo: target.repo, pr: target.pr, runId: "run-1", task: "titan-platform/TP-1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "correctness", ...(base !== undefined && { base }) });
  const fake = fakeGitHub();
  fake.prFiles.set(target.pr, [source("from-github.ts", 1)]);
  const reads: string[] = [];
  const prFiles: PrFilesRead = async ({ head, base: readBase }) => (reads.push(`${readBase}@${head}`), byHead[head] ?? []);
  return { deps: { store, port: githubPort(fake.wire), prFiles }, fake, reads };
}

describe("the PR's files from local git", () => {
  const OTHER = "d".repeat(40);
  const byHead = { [HEAD]: [source("src/small.ts", 5)], [OTHER]: [source("src/big.ts", 500)] };

  it("reads the panel's files from git at the review's head and the registered base, and none from GitHub", async () => {
    const { deps, fake, reads } = gitDeps("main", byHead);

    const read = await panelFacts(deps, target, "run-1");

    expect(read.facts.changedFiles.map((file) => file.path)).toEqual(["src/small.ts"]);
    expect(reads).toEqual([`main@${HEAD}`]);
    expect(fake.calls).toEqual([]);
  });

  it("sizes a spawn from git at the review's head, so a new head of the same PR is sized again", async () => {
    const { deps, fake } = gitDeps("main", byHead);
    const spawn = { mode: "spawn", at: 1 };

    const first = await spawnFacts(deps, "run-1", spawn, target, undefined);
    const second = await spawnFacts(deps, "run-1", spawn, { ...target, head: OTHER }, undefined);

    expect(first).toMatchObject({ changedLines: 5 });
    expect(second).toMatchObject({ changedLines: 500 });
    expect(fake.calls).toEqual([]);
  });

  it("reads GitHub when the registration names no base", async () => {
    const { deps, reads } = gitDeps(undefined, byHead);

    const read = await panelFacts(deps, target, "run-1");

    expect(read.facts.changedFiles.map((file) => file.path)).toEqual(["from-github.ts"]);
    expect(reads).toEqual([]);
  });
});

describe("panelFacts", () => {
  it("reads the registered kind and the PR's changed files", async () => {
    const read = await panelFacts(depsWith({ kind: "security" }, [source("src/auth.ts", 10)]), target, "run-1");

    expect(read).toEqual({ facts: { ...target, base: "", kind: "security", changedFiles: [{ path: "src/auth.ts", additions: 10, deletions: 0 }] }, sizeUnread: false });
  });

  it("leaves the kind out when the store cannot be read, so the PR classes as g10", async () => {
    const read = await panelFacts(depsWith("unreadable", [source("src/a.ts", 1)]), target, "run-1");

    expect(read.facts.kind).toBeUndefined();
    expect(intentPlan(read, panelPolicyFor()).class).toBe("g10");
  });

  it("marks the size unread when GitHub truncates the file list, which the port refuses to read", async () => {
    const read = await panelFacts(depsWith({ kind: "correctness" }, "truncated"), target, "run-1");

    expect(read).toMatchObject({ facts: { changedFiles: [] }, sizeUnread: true });
  });

  it("keeps the paths but marks the size unread when a file carries no line counts", async () => {
    const read = await panelFacts(depsWith({ kind: "correctness" }, [{ path: "src/a.ts", status: "modified" }]), target, "run-1");

    expect(read.sizeUnread).toBe(true);
    expect(read.facts.changedFiles.map((file) => file.path)).toEqual(["src/a.ts"]);
  });
});

describe("intentPlan", () => {
  it("plans a small tested correctness PR as standard with the correctness member alone", () => {
    const planned = intentPlan(facts("correctness", [source("src/a.ts", 20), source("src/a.test.ts", 10)]), panelPolicyFor());

    expect(planned).toMatchObject({ class: "standard", touches: [] });
    expect(shapes(planned)).toEqual(["correctness:reviewer"]);
  });

  it("adds the adversary to a security PR, with the configured g10 profile for correctness", () => {
    const planned = intentPlan(facts("security", [source("src/auth.ts", 20), source("src/auth.test.ts", 10)]), panelPolicyFor({ g10: "bd-opus", standard: "rv" }), { opus: true });

    expect(planned).toMatchObject({ class: "g10", touches: ["security"] });
    expect(shapes(planned)).toEqual(["correctness:bd-opus", "adversary:reviewer"]);
  });

  it("takes the g10 class and the large touch when the size is unread", () => {
    const planned = intentPlan(facts("correctness", [source("src/a.ts", 1), source("src/a.test.ts", 1)], true), panelPolicyFor());

    expect(planned).toMatchObject({ class: "g10", touches: ["large"] });
    expect(shapes(planned)).toEqual(["correctness:bd-reviewer", "perf:reviewer"]);
  });

  it("lowers the opus correctness member and marks the plan degraded when headroom refuses opus", () => {
    const planned = intentPlan(facts("security", [source("src/auth.ts", 20), source("src/auth.test.ts", 10)]), panelPolicyFor(), { opus: false });

    expect(planned.plan).toMatchObject({ degraded: true, members: [{ shape: "correctness", profile: "reviewer", degraded: true }, { shape: "adversary" }] });
  });

  it("classes a PR over the configured g10 line limit as large", () => {
    const roles = { g10: "bd-reviewer", standard: "reviewer", g10ChangedLines: 50 };

    const planned = intentPlan(facts("correctness", [source("src/a.ts", 60), source("src/a.test.ts", 0)]), panelPolicyFor(roles), undefined, classRulesFor(roles));

    expect(planned).toMatchObject({ class: "g10", touches: ["large"] });
  });

  describe("a g10-adversary hold's member", () => {
    const holdMember = { profile: DEFAULT_ADVERSARY_PROFILE };
    const plain = facts("correctness", [source("src/a.ts", 20), source("src/a.test.ts", 10)]);
    const large = facts("correctness", [source("src/a.ts", 1)], true);

    it("plans exactly one adversary beside correctness at fable-reviewer when the files touch nothing that asks for one", () => {
      const planned = intentPlan(plain, panelPolicyFor(), undefined, undefined, { holdMember, fullPanel: false });

      expect(shapes(planned)).toEqual(["correctness:reviewer", "adversary:fable-reviewer"]);
      expect(planned.plan.members[1]).toMatchObject({ blocking: true, degraded: false });
    });

    it("plans none without the hold's member, as with the flag off", () => {
      expect(shapes(intentPlan(plain, panelPolicyFor()))).toEqual(["correctness:reviewer"]);
    });

    it("keeps only correctness and the adversary when the panel is not on, so a held head starts no other member", () => {
      const planned = intentPlan(large, panelPolicyFor(), undefined, undefined, { holdMember, fullPanel: false });

      expect(shapes(planned)).toEqual(["correctness:bd-reviewer", "adversary:fable-reviewer"]);
    });

    it("puts the hold's adversary first among the panel's shapes under on, at the hold's profile rather than the table's", () => {
      const security = facts("security", [source("src/auth.ts", 20)], true);

      const planned = intentPlan(security, panelPolicyFor(), undefined, undefined, { holdMember });

      expect(shapes(planned)).toEqual(["correctness:bd-reviewer", "adversary:fable-reviewer", "tests:reviewer"]);
    });
  });
});

describe("withoutPlan", () => {
  it("drops the class, touches and plan and keeps every other intent field", () => {
    const intent = { kind: "intent", head: HEAD, reviewer: "rv", at: 1, mode: "spawn", class: "g10", touches: [], plan: { members: [] } };

    expect(withoutPlan(intent)).toEqual({ kind: "intent", head: HEAD, reviewer: "rv", at: 1, mode: "spawn" });
  });
});
