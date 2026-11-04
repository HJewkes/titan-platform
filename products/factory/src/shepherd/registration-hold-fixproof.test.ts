import { fakeGitHub, fakeSha, githubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { g10HoldAt } from "./registration-hold.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";

const file = (path: string, additions: number): PrFile => ({ path, status: "modified", additions, deletions: 0 });

function holdFor(files: PrFile[]): Promise<string | undefined> {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: fakeSha("head-1") });
  fake.prFiles.set(pr, files);
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "feature" });
  return g10HoldAt(githubPort(fake.wire), { repo: REPO, pr });
}

describe("the G10 hold Shepherd places at registration on the fix-proof gate's config", () => {
  it("holds a change to only .github/fix-proof.json g10-adversary", async () => {
    expect(await holdFor([file(".github/fix-proof.json", 4)])).toBe("g10-adversary: policy touch");
  });
});
