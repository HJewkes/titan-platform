import { fakeGitHub, fakeSha, githubPort, type GitHubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { awaitPrRoute } from "./await-pr.js";
import { shepherdEventMigration } from "./events.js";
import type { ShepherdDeps } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration, type ShepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const BRANCH = "feat/demo";

function rig(files: PrFile[]): { port: GitHubPort; store: ShepherdStoreRef } {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
  const store = shepherdStoreRef();
  store.bind(db);
  store.get().register({ repo: REPO, branch: BRANCH, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "feature" });
  const fake = fakeGitHub({ repo: REPO });
  const { number } = fake.addPr({ headSha: fakeSha("head-1"), headRef: BRANCH });
  fake.prFiles.set(number, files);
  return { port: githubPort(fake.wire), store };
}

async function awaitPr(port: GitHubPort, store: ShepherdStoreRef): Promise<boolean> {
  const deps: ShepherdDeps = { port, store, now: () => 0, sleep: async () => undefined, pollMs: 1, agentChatBin: "agent-chat" };
  const prompt = JSON.stringify({ repo: REPO, branch: BRANCH, runId: "run-1" });
  const outcome = await awaitPrRoute(deps).runner.run({ runId: "run-1", workflowName: "shepherd-pr", stepId: "sh-await-pr:0", iteration: 0, prompt, signal: new AbortController().signal, attempt: 0, requestKey: "k" });
  return outcome.ok;
}

describe("sh-await-pr on a branch-only registration", () => {
  it("holds the run g10-review when the PR it finds is over 400 changed lines", async () => {
    const { port, store } = rig([{ path: "packages/x/src/a.ts", status: "modified", additions: 450, deletions: 0 }]);

    expect(await awaitPr(port, store)).toBe(true);
    expect(store.get().byRun("run-1")).toMatchObject({ pr: 1, held: true, holdReason: "g10-review: 450 changed lines" });
  });

  it("holds the run g10-adversary when the PR it finds touches an authority path", async () => {
    const { port, store } = rig([{ path: "packages/authority/src/x.ts", status: "modified", additions: 5, deletions: 0 }]);

    await awaitPr(port, store);

    expect(store.get().byRun("run-1")?.holdReason).toBe("g10-adversary: authority touch");
  });

  it("holds the run g10-adversary when the found PR's files cannot be read", async () => {
    const { port, store } = rig([]);

    await awaitPr({ ...port, listPrFiles: () => Promise.reject(new Error("server error")) }, store);

    expect(store.get().byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-adversary: changed files unread at registration (Error)" });
  });

  it("leaves the run unheld when the PR it finds is small plain source", async () => {
    const { port, store } = rig([{ path: "packages/x/src/a.ts", status: "modified", additions: 30, deletions: 0 }]);

    await awaitPr(port, store);

    expect(store.get().byRun("run-1")).toMatchObject({ pr: 1, held: false });
  });
});
