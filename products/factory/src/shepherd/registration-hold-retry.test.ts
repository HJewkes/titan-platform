import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { applyRegistrationHold } from "./registration-hold.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";

const file = (path: string, additions: number, deletions = 0): PrFile => ({ path, status: "modified", additions, deletions });

interface Rig {
  fake: FakeGitHub;
  port: GitHubPort;
  store: ShepherdStore;
}

function rig(files: PrFile[]): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: fakeSha("head-1") });
  fake.prFiles.set(pr, files);
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "feature" });
  return { fake, port: githubPort(fake.wire), store };
}

describe("the file list Shepherd reads at registration when GitHub's count and list disagree", () => {
  it("reads again after a wait when the count outruns the list below the cap, and classes the whole list", async () => {
    const r = rig([file("packages/x/src/a.ts", 5)]);
    r.fake.prChangedFiles.set(1, 2);
    const waits: number[] = [];
    const pause = async (ms: number) => void (waits.push(ms), r.fake.prChangedFiles.set(1, 1));

    expect(await applyRegistrationHold(r.port, r.store, "run-1", { pause })).toBeUndefined();
    expect(waits).toHaveLength(1);
    expect(r.store.byRun("run-1")?.held).toBe(false);
  });

  it("holds as unread when the list is short of its count on both reads, waiting once", async () => {
    const r = rig([file("packages/x/src/a.ts", 5)]);
    r.fake.prChangedFiles.set(1, 2);
    const waits: number[] = [];

    const reason = await applyRegistrationHold(r.port, r.store, "run-1", { pause: async (ms) => void waits.push(ms) });

    expect(reason).toBe("g10-adversary: changed files unread at registration (FileListTruncatedError)");
    expect(waits).toHaveLength(1);
  });

  it("does not re-read a file list cut short at GitHub's cap", async () => {
    const r = rig([file("packages/x/src/a.ts", 5)]);
    r.fake.prChangedFiles.set(1, 5000);
    const listPrFiles = r.port.listPrFiles;
    let reads = 0;
    r.port = { ...r.port, listPrFiles: (repo, pr) => (reads++, listPrFiles(repo, pr)) };

    const waits: number[] = [];

    expect(await applyRegistrationHold(r.port, r.store, "run-1", { pause: async (ms) => void waits.push(ms) })).toBe("g10-adversary: changed files unread at registration (FileListTruncatedError)");
    expect(reads).toBe(1);
    expect(waits).toEqual([]);
  });
});
